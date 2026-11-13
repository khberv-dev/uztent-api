import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../shared/redis/redis.module.js';
import type { ServerEvent } from './events.types.js';

const CHANNEL = 'events';

/**
 * Fan-out for WebSocket events.
 * - `publish`: goes through Redis pub/sub, so clients on every API instance
 *   get it (stream start/end happen on whichever instance got the webhook).
 * - `broadcastLocal`: only this instance's clients (viewer counts, which every
 *   instance polls itself).
 */
@Injectable()
export class EventsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EventsService.name);
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  /** A Redis connection in subscribe mode can't run other commands. */
  private readonly subscriber: Redis;

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    this.subscriber = redis.duplicate();
  }

  async onModuleInit() {
    this.subscriber.on('message', (_channel: string, message: string) => {
      try {
        this.emit(JSON.parse(message) as ServerEvent);
      } catch (error) {
        this.logger.warn(`Bad event message: ${String(error)}`);
      }
    });
    await this.subscriber.subscribe(CHANNEL);
  }

  async onApplicationShutdown() {
    await this.subscriber.quit();
  }

  async publish(event: ServerEvent): Promise<void> {
    await this.redis.publish(CHANNEL, JSON.stringify(event));
  }

  broadcastLocal(event: ServerEvent): void {
    this.emit(event);
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ServerEvent) {
    for (const listener of this.listeners) listener(event);
  }
}
