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

/** Subset of MediaMTX `GET /v3/hlssessions/list`. */
interface MediamtxHlsSessionList {
  pageCount: number;
  items: { id: string; path: string; outboundBytes: number }[];
}

/** `live/<streamId>` or `watch/<streamId>/<quality>` → streamId. */
const STREAM_PATH = /^(?:live|watch)\/([0-9a-f-]{36})(?:\/|$)/i;

/**
 * A session seen for the first time counts only if it already received media:
 * fetching just the multivariant playlist (link previews, crawlers, a reload
 * that replaced the session) sends a few hundred bytes.
 */
const MIN_MEDIA_BYTES = 16 * 1024;

/**
 * A playing HLS client requests something at least every target duration
 * (~2 s, playlist reloads included), so a session that sent nothing for this
 * long has been abandoned, even though MediaMTX keeps it ~30 s more.
 */
const MIN_ACTIVE_WINDOW_MS = 10_000;

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
 * HLS viewers are MediaMTX HLS sessions on `live/<id>` and `watch/<id>/*`
 * that are still downloading (their `outboundBytes` grew recently). Counting
 * every session would overcount: each playlist load opens a new one (page
 * reload, quality switch, player error recovery) and an abandoned one lingers
 * ~30 s. Other readers (e.g. RTMP players) are counted from the path list,
 * minus the transcoder's RTSP read of `live/<id>` (see mediamtx.yml).
 */
@Injectable()
export class ViewerCounterService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ViewerCounterService.name);
  private readonly apiUrl: string;
  private readonly intervalMs: number;
  private readonly activeWindowMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private failing = false;
  /** HLS session id → bytes at the last poll and when they last grew. */
  private readonly hlsSessions = new Map<
    string,
    { bytes: number; lastActiveAt: number | null }
  >();

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
    this.activeWindowMs = Math.max(MIN_ACTIVE_WINDOW_MS, 2 * this.intervalMs);
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
      if (sessions.length === 0) {
        this.hlsSessions.clear();
        return;
      }

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
    const [paths, hlsSessions] = await Promise.all([
      this.list<MediamtxPathList>('/v3/paths/list'),
      this.list<MediamtxHlsSessionList>('/v3/hlssessions/list'),
    ]);
    const counts = new Map<string, number>();
    const add = (path: string, viewers: number) => {
      const streamId = STREAM_PATH.exec(path)?.[1]?.toLowerCase();
      if (streamId && viewers) {
        counts.set(streamId, (counts.get(streamId) ?? 0) + viewers);
      }
    };

    for (const path of paths) {
      const isSource = path.name.startsWith('live/');
      add(
        path.name,
        path.readers.filter(
          (reader) =>
            // HLS sessions are counted below, by activity.
            reader.type !== 'hlsSession' &&
            // The transcoder reads the source over RTSP (bound to 127.0.0.1).
            !(isSource && reader.type === 'rtspSession'),
        ).length,
      );
    }

    const now = Date.now();
    const seen = new Set<string>();
    for (const session of hlsSessions) {
      seen.add(session.id);
      const bytes = Number(session.outboundBytes) || 0;
      const previous = this.hlsSessions.get(session.id);
      let lastActiveAt: number | null;
      if (!previous) {
        lastActiveAt = bytes >= MIN_MEDIA_BYTES ? now : null;
      } else {
        lastActiveAt = bytes > previous.bytes ? now : previous.lastActiveAt;
      }
      this.hlsSessions.set(session.id, { bytes, lastActiveAt });
      if (lastActiveAt !== null && now - lastActiveAt <= this.activeWindowMs) {
        add(session.path, 1);
      }
    }
    for (const id of this.hlsSessions.keys()) {
      if (!seen.has(id)) this.hlsSessions.delete(id);
    }
    return counts;
  }

  /** All pages of a MediaMTX list endpoint. */
  private async list<T extends { pageCount: number; items: unknown[] }>(
    endpoint: string,
  ): Promise<T['items']> {
    const items: T['items'] = [];
    for (let page = 0, pageCount = 1; page < pageCount; page++) {
      const response = await fetch(
        `${this.apiUrl}${endpoint}?itemsPerPage=1000&page=${page}`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (!response.ok) {
        throw new Error(`MediaMTX ${endpoint} responded ${response.status}`);
      }
      const list = (await response.json()) as T;
      pageCount = list.pageCount;
      items.push(...list.items);
    }
    return items;
  }
}
