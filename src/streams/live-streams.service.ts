import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type {
  Paginated,
  PaginationQueryDto,
} from '../common/dto/pagination.dto.js';
import { EventsService } from '../events/events.service.js';
import { REDIS } from '../shared/redis/redis.module.js';
import type { Vod } from '../vods/entities/vod.entity.js';
import { UsersService } from '../users/users.service.js';
import { VodsService } from '../vods/vods.service.js';
import type { LiveStream, Rendition } from './live-stream.interface.js';

/**
 * Redis layout:
 * - `stream:<id>`        hash: id, userId, streamId, title, startedAt, viewers,
 *                        peakViewers (URLs are built on read from streamId)
 * - `stream:user:<uid>`  string: ID of the user's live stream (one per user)
 * - `streams:live`       sorted set of live stream IDs, scored by start time
 */
const liveStreamKey = (id: string) => `stream:${id}`;
const userStreamKey = (userId: string) => `stream:user:${userId}`;
const LIVE_KEY = 'streams:live';

@Injectable()
export class LiveStreamsService {
  private readonly hlsBaseUrl: string;
  /** Rendition heights, highest first, e.g. [1080]. */
  private readonly renditions: string[];

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly vodsService: VodsService,
    private readonly usersService: UsersService,
    private readonly eventsService: EventsService,
    config: ConfigService,
  ) {
    this.hlsBaseUrl = config
      .getOrThrow<string>('HLS_BASE_URL')
      .replace(/\/+$/, '');
    this.renditions = config
      .getOrThrow<string>('STREAM_RENDITIONS')
      .split(',')
      .map((quality) => quality.trim().replace(/p$/i, ''))
      .filter(Boolean)
      .sort((a, b) => Number(b) - Number(a));
  }

  /**
   * Starts a live session for the user. If one is already live (e.g. the
   * encoder reconnected), returns it instead of starting a second one.
   */
  async start({
    userId,
    streamId,
    title,
    chatSlowModeSeconds,
  }: {
    userId: string;
    /** The user's Stream entity id: also the MediaMTX path, so the HLS URL. */
    streamId: string;
    title: string;
    chatSlowModeSeconds: number;
  }): Promise<LiveStream> {
    const id = randomUUID();

    // Claim the user's single live-stream slot atomically.
    if (!(await this.redis.set(userStreamKey(userId), id, 'NX'))) {
      const existing = await this.findByUser(userId);
      if (existing) return existing;

      // Slot points at a missing session: clear it and claim again.
      await this.redis.del(userStreamKey(userId));
      if (!(await this.redis.set(userStreamKey(userId), id, 'NX'))) {
        throw new ConflictException('A live stream is already starting');
      }
    }

    const startedAt = new Date();
    const hash = {
      id,
      userId,
      streamId,
      title,
      startedAt: startedAt.toISOString(),
      viewers: '0',
      peakViewers: '0',
      chatSlowModeSeconds: String(chatSlowModeSeconds),
    };

    await this.redis
      .multi()
      .hset(liveStreamKey(id), hash)
      .zadd(LIVE_KEY, startedAt.getTime(), id)
      .exec();

    const stream = this.toLiveStream(hash)!;
    await this.eventsService.publish({ event: 'stream.started', data: stream });
    return stream;
  }

  /**
   * Removes the user's live session from Redis and records it as a VOD.
   * Returns null if the user isn't live.
   */
  async end(userId: string): Promise<Vod | null> {
    const id = await this.redis.get(userStreamKey(userId));
    if (!id) return null;

    const hash = await this.redis.hgetall(liveStreamKey(id));
    if (!hash.id) {
      await this.removeFromRedis(id, userId);
      return null;
    }

    // Save the VOD first: if it fails, the stream stays live and end can be retried.
    const vod = await this.vodsService.create({
      id,
      userId,
      title: hash.title,
      peakViewers: Number(hash.peakViewers ?? 0),
      startedAt: new Date(hash.startedAt),
      endedAt: new Date(),
    });

    await this.removeFromRedis(id, userId);
    await this.eventsService.publish({
      event: 'stream.ended',
      data: { id, userId, vodId: vod.id },
    });
    return vod;
  }

  async findByUser(userId: string): Promise<LiveStream | null> {
    const id = await this.redis.get(userStreamKey(userId));
    if (!id) return null;
    return this.toLiveStream(await this.redis.hgetall(liveStreamKey(id)));
  }

  async getByUsername(username: string): Promise<LiveStream> {
    const user = await this.usersService.findByUsername(username.trim());
    if (!user) throw new NotFoundException('User not found');

    const stream = await this.findByUser(user.id);
    if (!stream) throw new NotFoundException('User is not live');
    return stream;
  }

  /** Redis key + MediaMTX stream id of every live session (for ViewerCounterService). */
  async listSessionKeys(): Promise<
    { id: string; key: string; streamId: string }[]
  > {
    const ids = await this.redis.zrange(LIVE_KEY, 0, -1);
    if (ids.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hget(liveStreamKey(id), 'streamId');
    const results = (await pipeline.exec()) ?? [];

    return ids.flatMap((id, i) => {
      const streamId = results[i]?.[1];
      return typeof streamId === 'string'
        ? [{ id, key: liveStreamKey(id), streamId: streamId.toLowerCase() }]
        : [];
    });
  }

  /**
   * Applies stream settings to the user's live session, if they're live.
   * A slow mode change is pushed to the chat (chat.settings).
   */
  async updateLive(
    userId: string,
    changes: { title?: string; chatSlowModeSeconds?: number },
  ): Promise<void> {
    const live = await this.findByUser(userId);
    if (!live) return;

    const fields: Record<string, string> = {};
    if (changes.title !== undefined) fields.title = changes.title;
    if (changes.chatSlowModeSeconds !== undefined) {
      fields.chatSlowModeSeconds = String(changes.chatSlowModeSeconds);
    }
    if (Object.keys(fields).length === 0) return;
    await this.redis.hset(liveStreamKey(live.id), fields);

    if (
      changes.chatSlowModeSeconds !== undefined &&
      changes.chatSlowModeSeconds !== live.chatSlowModeSeconds
    ) {
      await this.eventsService.publish({
        event: 'chat.settings',
        data: {
          streamId: live.id,
          slowModeSeconds: changes.chatSlowModeSeconds,
        },
      });
    }
  }

  async getById(id: string): Promise<LiveStream> {
    const stream = this.toLiveStream(
      await this.redis.hgetall(liveStreamKey(id)),
    );
    if (!stream) throw new NotFoundException('Stream not found');
    return stream;
  }

  /** Live streams, newest first. */
  async list({
    page,
    limit,
    offset,
  }: PaginationQueryDto): Promise<Paginated<LiveStream>> {
    const [ids, total] = await Promise.all([
      this.redis.zrevrange(LIVE_KEY, offset, offset + limit - 1),
      this.redis.zcard(LIVE_KEY),
    ]);

    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(liveStreamKey(id));
    const results = (await pipeline.exec()) ?? [];

    const items = results
      .map(([, hash]) => this.toLiveStream(hash as Record<string, string>))
      .filter((stream): stream is LiveStream => stream !== null);

    return { items, total, page, limit };
  }

  private async removeFromRedis(id: string, userId: string) {
    await this.redis
      .multi()
      .del(liveStreamKey(id))
      .del(userStreamKey(userId))
      .zrem(LIVE_KEY, id)
      .exec();
  }

  /** Playback URLs follow the MediaMTX paths in mediamtx.yml. */
  private toLiveStream(hash: Record<string, string>): LiveStream | null {
    if (!hash.id) return null;
    return {
      id: hash.id,
      userId: hash.userId,
      title: hash.title,
      startedAt: hash.startedAt,
      viewers: Number(hash.viewers ?? 0),
      ...this.playbackUrls(hash),
      chatSlowModeSeconds: Number(hash.chatSlowModeSeconds ?? 0),
    };
  }

  private playbackUrls(
    hash: Record<string, string>,
  ): Pick<LiveStream, 'url' | 'renditions'> {
    // Sessions started before streamId was stored only have a fixed url.
    if (!hash.streamId) return { url: hash.url ?? '', renditions: [] };

    const renditions: Rendition[] = this.renditions.map((quality) => ({
      quality: `${quality}p`,
      url: `${this.hlsBaseUrl}/watch/${hash.streamId}/${quality}/index.m3u8`,
    }));
    return {
      url: `${this.hlsBaseUrl}/live/${hash.streamId}/index.m3u8`,
      renditions,
    };
  }
}
