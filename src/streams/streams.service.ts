import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Repository } from 'typeorm';
import type { UpdateStreamDto } from './dto/update-stream.dto.js';
import { Stream } from './entities/stream.entity.js';
import { LiveStreamsService } from './live-streams.service.js';

/** The user's static stream settings (title, stream key, publish URL) in Postgres. */
@Injectable()
export class StreamsService {
  private readonly publishUrl: string;

  constructor(
    @InjectRepository(Stream) private readonly streams: Repository<Stream>,
    private readonly liveStreamsService: LiveStreamsService,
    config: ConfigService,
  ) {
    this.publishUrl = config
      .getOrThrow<string>('STREAM_PUBLISH_URL')
      .replace(/\/+$/, '');
  }

  async getByUser(userId: string): Promise<Stream> {
    const stream = await this.streams.findOneBy({ userId });
    if (!stream) {
      throw new NotFoundException(
        'No stream key yet. Generate one with POST /streams/me/key',
      );
    }
    return stream;
  }

  findById(id: string): Promise<Stream | null> {
    return this.streams.findOneBy({ id });
  }

  isValidKey(stream: Stream, key: string): boolean {
    const expected = Buffer.from(stream.streamKey);
    const actual = Buffer.from(key);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  /**
   * Creates the user's stream settings, or replaces the key if they exist
   * (id and title are kept). New publishes need the new key; an encoder that
   * is already connected stays connected.
   */
  async generateKey(userId: string): Promise<Stream> {
    await this.streams.upsert(
      {
        userId,
        streamKey: `sk_${randomBytes(24).toString('base64url')}`,
        publishUrl: this.publishUrl,
      },
      { conflictPaths: ['userId'] },
    );
    return this.getByUser(userId);
  }

  /** Also applies to the current live session, if the user is live. */
  async update(userId: string, dto: UpdateStreamDto): Promise<Stream> {
    const stream = await this.getByUser(userId);
    if (dto.title !== undefined) stream.title = dto.title;
    if (dto.chatSlowModeSeconds !== undefined) {
      stream.chatSlowModeSeconds = dto.chatSlowModeSeconds;
    }
    await this.streams.save(stream);
    await this.liveStreamsService.updateLive(userId, dto);
    return stream;
  }
}
