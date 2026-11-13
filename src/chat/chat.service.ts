import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { LessThan, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/utils/is-unique-violation.js';
import { EventsService } from '../events/events.service.js';
import { REDIS } from '../shared/redis/redis.module.js';
import { LiveStreamsService } from '../streams/live-streams.service.js';
import { UsersService } from '../users/users.service.js';
import { VodsService } from '../vods/vods.service.js';
import { ChatBan } from './entities/chat-ban.entity.js';
import { ChatMessage } from './entities/chat-message.entity.js';
import { ChatModerator } from './entities/chat-moderator.entity.js';

export type ChatRole = 'streamer' | 'moderator' | 'viewer';

export interface ChatHistory {
  /** Oldest first. */
  items: ChatMessage[];
  /** More (older) messages exist: pass `before` = items[0].createdAt. */
  hasMore: boolean;
}

export interface ChannelUser {
  userId: string;
  username: string | null;
  firstName: string;
  lastName: string;
  /** When they were banned / promoted. */
  since: Date;
}

export interface ChatPermissions {
  role: ChatRole;
  banned: boolean;
  /** Current slow mode of the live stream (0 when off or not live). */
  slowModeSeconds: number;
  /** Delete messages, ban and unban in this chat. */
  canModerate: boolean;
}

@Injectable()
export class ChatService {
  /** Minimum time between two messages from the same user, in any chat. */
  private readonly messageIntervalMs: number;

  constructor(
    @InjectRepository(ChatMessage)
    private readonly messages: Repository<ChatMessage>,
    @InjectRepository(ChatBan) private readonly bans: Repository<ChatBan>,
    @InjectRepository(ChatModerator)
    private readonly moderators: Repository<ChatModerator>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly liveStreamsService: LiveStreamsService,
    private readonly vodsService: VodsService,
    private readonly usersService: UsersService,
    private readonly eventsService: EventsService,
    config: ConfigService,
  ) {
    this.messageIntervalMs = Number(
      config.getOrThrow('CHAT_MESSAGE_INTERVAL_MS'),
    );
  }

  // ---- Reading -------------------------------------------------------------

  /** Public. Works while live and after the stream ended (VOD id). */
  async history(
    streamId: string,
    { before, limit }: { before?: string; limit: number },
  ): Promise<ChatHistory> {
    const rows = await this.messages.find({
      where: {
        streamId,
        ...(before ? { createdAt: LessThan(new Date(before)) } : {}),
      },
      order: { createdAt: 'DESC' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).reverse(), hasMore };
  }

  /** What the caller may do in this stream's chat (live or VOD). */
  async permissions(
    streamId: string,
    userId: string,
  ): Promise<ChatPermissions> {
    const { ownerId, slowModeSeconds } = await this.channelOf(streamId);
    const role = await this.roleIn(ownerId, userId);
    return {
      role,
      banned: role === 'viewer' && (await this.isBanned(ownerId, userId)),
      slowModeSeconds,
      canModerate: role !== 'viewer',
    };
  }

  // ---- Writing -------------------------------------------------------------

  async send(
    streamId: string,
    senderId: string,
    text: string,
  ): Promise<ChatMessage> {
    const stream = await this.liveStreamsService.getById(streamId); // 404 if not live
    const role = await this.roleIn(stream.userId, senderId);

    if (role === 'viewer' && (await this.isBanned(stream.userId, senderId))) {
      throw new ForbiddenException('You are banned from this chat');
    }

    // Everyone: global anti-spam interval.
    const allowed = await this.redis.set(
      `chat:rate:${senderId}`,
      '1',
      'PX',
      this.messageIntervalMs,
      'NX',
    );
    if (!allowed) {
      throw new HttpException(
        'You are sending messages too fast',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Viewers: the channel's slow mode.
    if (role === 'viewer' && stream.chatSlowModeSeconds > 0) {
      const key = `chat:slow:${stream.userId}:${senderId}`;
      const ok = await this.redis.set(
        key,
        '1',
        'EX',
        stream.chatSlowModeSeconds,
        'NX',
      );
      if (!ok) {
        const waitMs = Math.max(await this.redis.pttl(key), 0);
        throw new HttpException(
          `Slow mode is on: wait ${Math.ceil(waitMs / 1000)} s before your next message`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const sender = await this.usersService.getById(senderId);
    const message = await this.messages.save(
      this.messages.create({
        streamId,
        userId: senderId,
        senderName: sender.username ?? sender.firstName,
        senderRole: role === 'viewer' ? null : role,
        text,
      }),
    );

    await this.eventsService.publish({
      event: 'chat.message',
      data: {
        id: message.id,
        streamId,
        userId: message.userId,
        senderName: message.senderName,
        senderRole: message.senderRole,
        text: message.text,
        createdAt: message.createdAt.toISOString(),
      },
    });
    return message;
  }

  // ---- Moderation (streamer or moderator) ----------------------------------

  async delete(
    streamId: string,
    messageId: string,
    actorId: string,
  ): Promise<void> {
    const message = await this.messages.findOneBy({ id: messageId, streamId });
    if (!message) throw new NotFoundException('Message not found');

    const { ownerId } = await this.channelOf(streamId);
    await this.assertCanModerate(ownerId, actorId);

    await this.messages.delete(message.id);
    await this.eventsService.publish({
      event: 'chat.deleted',
      data: { id: message.id, streamId },
    });
  }

  /** Ban from the chat of the stream's owner (all their streams). */
  async banInStream(streamId: string, actorId: string, targetId: string) {
    const { ownerId } = await this.channelOf(streamId);
    await this.ban(ownerId, actorId, targetId);
  }

  async unbanInStream(streamId: string, actorId: string, targetId: string) {
    const { ownerId } = await this.channelOf(streamId);
    await this.assertCanModerate(ownerId, actorId);
    await this.bans.delete({ channelUserId: ownerId, userId: targetId });
  }

  /**
   * Streamer: can ban anyone but themselves; banning a moderator removes the
   * role. Moderator: can only ban viewers.
   */
  async ban(channelUserId: string, actorId: string, targetId: string) {
    const actorRole = await this.assertCanModerate(channelUserId, actorId);
    if (targetId === channelUserId) {
      throw new BadRequestException(
        actorId === channelUserId
          ? "You can't ban yourself"
          : "The streamer can't be banned",
      );
    }
    await this.usersService.getById(targetId); // 404 if unknown

    const targetRole = await this.roleIn(channelUserId, targetId);
    if (targetRole === 'moderator') {
      if (actorRole !== 'streamer') {
        throw new ForbiddenException("Moderators can't ban other moderators");
      }
      await this.moderators.delete({ channelUserId, userId: targetId });
    }

    try {
      await this.bans.insert({ channelUserId, userId: targetId });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error; // already banned: fine
    }
  }

  async unban(channelUserId: string, userId: string): Promise<void> {
    await this.bans.delete({ channelUserId, userId });
  }

  async listBans(channelUserId: string): Promise<ChannelUser[]> {
    const rows = await this.bans.find({
      where: { channelUserId },
      relations: { user: true },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toChannelUser);
  }

  // ---- Moderators (streamer only: their own channel) -----------------------

  async listModerators(channelUserId: string): Promise<ChannelUser[]> {
    const rows = await this.moderators.find({
      where: { channelUserId },
      relations: { user: true },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toChannelUser);
  }

  /** Promoting a banned user lifts the ban. */
  async addModerator(channelUserId: string, userId: string): Promise<void> {
    if (userId === channelUserId) {
      throw new BadRequestException(
        'You are already the streamer of your channel',
      );
    }
    await this.usersService.getById(userId); // 404 if unknown
    await this.bans.delete({ channelUserId, userId });
    try {
      await this.moderators.insert({ channelUserId, userId });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error; // already a moderator
    }
  }

  async removeModerator(channelUserId: string, userId: string) {
    await this.moderators.delete({ channelUserId, userId });
  }

  // ---- Helpers -------------------------------------------------------------

  private async roleIn(channelUserId: string, userId: string) {
    if (userId === channelUserId) return 'streamer' as const;
    return (await this.moderators.existsBy({ channelUserId, userId }))
      ? ('moderator' as const)
      : ('viewer' as const);
  }

  private async assertCanModerate(channelUserId: string, actorId: string) {
    const role = await this.roleIn(channelUserId, actorId);
    if (role === 'viewer') {
      throw new ForbiddenException(
        'Only the streamer and moderators can do this',
      );
    }
    return role;
  }

  private isBanned(channelUserId: string, userId: string) {
    return this.bans.existsBy({ channelUserId, userId });
  }

  /** Owner of a live stream or VOD (404 if neither), plus its slow mode. */
  private async channelOf(streamId: string) {
    try {
      const live = await this.liveStreamsService.getById(streamId);
      return {
        ownerId: live.userId,
        slowModeSeconds: live.chatSlowModeSeconds,
      };
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      const vod = await this.vodsService.getById(streamId);
      return { ownerId: vod.userId, slowModeSeconds: 0 };
    }
  }
}

function toChannelUser(row: {
  userId: string;
  createdAt: Date;
  user: { username: string | null; firstName: string; lastName: string };
}): ChannelUser {
  return {
    userId: row.userId,
    username: row.user.username,
    firstName: row.user.firstName,
    lastName: row.user.lastName,
    since: row.createdAt,
  };
}
