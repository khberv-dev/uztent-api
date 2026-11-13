import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  Paginated,
  PaginationQueryDto,
} from '../common/dto/pagination.dto.js';
import { isUniqueViolation } from '../common/utils/is-unique-violation.js';
import { ChatMessage } from '../chat/entities/chat-message.entity.js';
import { Vod } from './entities/vod.entity.js';

export interface CreateVodData {
  id: string;
  userId: string;
  title: string;
  peakViewers: number;
  startedAt: Date;
  endedAt: Date;
}

@Injectable()
export class VodsService {
  constructor(
    @InjectRepository(Vod) private readonly vods: Repository<Vod>,
    @InjectRepository(ChatMessage)
    private readonly chatMessages: Repository<ChatMessage>,
  ) {}

  /** Idempotent: a second call for the same stream returns the existing VOD. */
  async create(data: CreateVodData): Promise<Vod> {
    try {
      return await this.vods.save(
        this.vods.create({ ...data, previewUri: null, videoUri: null }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) return this.getById(data.id);
      throw error;
    }
  }

  async getById(id: string): Promise<Vod> {
    const vod = await this.vods.findOneBy({ id });
    if (!vod) throw new NotFoundException('VOD not found');
    return vod;
  }

  async listByUser(
    userId: string,
    { page, limit, offset }: PaginationQueryDto,
  ): Promise<Paginated<Vod>> {
    const [items, total] = await this.vods.findAndCount({
      where: { userId },
      order: { startedAt: 'DESC' },
      skip: offset,
      take: limit,
    });
    return { items, total, page, limit };
  }

  async delete(id: string, userId: string): Promise<void> {
    const vod = await this.getById(id);
    if (vod.userId !== userId) {
      throw new ForbiddenException('You can only delete your own VODs');
    }
    await this.vods.delete(id);
    await this.chatMessages.delete({ streamId: id }); // its chat replay
  }
}
