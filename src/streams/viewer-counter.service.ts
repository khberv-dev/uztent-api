import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { EventsService } from '../events/events.service.js';
import { REDIS } from '../shared/redis/redis.module.js';
import { LiveStreamsService } from './live-streams.service.js';

/** Subset of MediaMTX `GET /v3/paths/list`. */
interface MediamtxPathList {
  pageCount: number;
  items: {
    name: string;
    readers: { type: string; id: string }[];
  }[];
}

/** `live/<streamId>` or `watch/<streamId>/<quality>` → streamId. */
const STREAM_PATH = /^(?:live|watch)\/([0-9a-f-]{36})(?:\/|$)/i;

/**
 * Sets `viewers` and keeps the max in `peakViewers`, only if the session still
 * exists (so a poll racing with stream end can't recreate the hash).
 */
const UPDATE_VIEWERS = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local viewers = tonumber(ARGV[1])
redis.call('HSET', KEYS[1], 'viewers', viewers)
local peak = tonumber(redis.call('HGET', KEYS[1], 'peakViewers') or '0')
if viewers > peak then redis.call('HSET', KEYS[1], 'peakViewers', viewers) end
return 1
`;

/**
 * Polls MediaMTX's API and writes each live session's viewer count.
 *
 * Every HLS player is a reader (`hlsSession`) on the path it plays, so viewers
 * = readers on `live/<id>` and `watch/<id>/*`, minus the transcoder's RTSP
 * read of `live/<id>` (see mediamtx.yml).
 */
@Injectable()
export class ViewerCounterService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ViewerCounterService.name);
  private readonly apiUrl: string;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private failing = false;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly liveStreamsService: LiveStreamsService,
    private readonly eventsService: EventsService,
    config: ConfigService,
  ) {
    this.apiUrl = config
      .getOrThrow<string>('MEDIAMTX_API_URL')
      .replace(/\/+$/, '');
    this.intervalMs = Number(config.getOrThrow('VIEWERS_POLL_SECONDS')) * 1000;
  }

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  /** One polling round. Skipped if the previous one is still running. */
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sessions = await this.liveStreamsService.listSessionKeys();
      if (sessions.length === 0) return;

      const counts = await this.countViewersByStream();
      const pipeline = this.redis.pipeline();
      for (const { key, streamId } of sessions) {
        pipeline.eval(UPDATE_VIEWERS, 1, key, counts.get(streamId) ?? 0);
      }
      await pipeline.exec();

      // Every instance polls, so each tells only its own WebSocket clients.
      this.eventsService.broadcastLocal({
        event: 'stream.viewers',
        data: sessions.map(({ id, streamId }) => ({
          id,
          viewers: counts.get(streamId) ?? 0,
        })),
      });

      if (this.failing) this.logger.log('Viewer counting recovered');
      this.failing = false;
    } catch (error) {
      // Keep the last counts; log once per outage, not every round.
      if (!this.failing) {
        this.logger.warn(`Viewer counting failed: ${String(error)}`);
      }
      this.failing = true;
    } finally {
      this.running = false;
    }
  }

  private async countViewersByStream(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();

    for (let page = 0, pageCount = 1; page < pageCount; page++) {
      const response = await fetch(
        `${this.apiUrl}/v3/paths/list?itemsPerPage=1000&page=${page}`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (!response.ok) {
        throw new Error(`MediaMTX API responded ${response.status}`);
      }
      const list = (await response.json()) as MediamtxPathList;
      pageCount = list.pageCount;

      for (const path of list.items) {
        const streamId = STREAM_PATH.exec(path.name)?.[1]?.toLowerCase();
        if (!streamId) continue;

        const isSource = path.name.startsWith('live/');
        const viewers = path.readers.filter(
          // The transcoder reads the source over RTSP; viewers use HLS
          // (RTSP is bound to 127.0.0.1 in mediamtx.yml).
          (reader) => !(isSource && reader.type === 'rtspSession'),
        ).length;

        counts.set(streamId, (counts.get(streamId) ?? 0) + viewers);
      }
    }
    return counts;
  }
}
