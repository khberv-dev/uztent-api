import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type {
  Paginated,
  PaginationQueryDto,
} from '../common/dto/pagination.dto.js';
import { Stream } from '../streams/entities/stream.entity.js';
import { UsersService } from '../users/users.service.js';
import { Follow } from './entities/follow.entity.js';

export interface FollowStatus {
  /** The caller follows this user (false when not signed in). */
  following: boolean;
  followersCount: number;
}

export interface FollowUser {
  userId: string;
  username: string | null;
  /** Shown when there's no username (like chat); last names stay private. */
  firstName: string;
  /** When the follow happened. */
  since: Date;
}

/**
 * Follows between users. The followed user's counter lives on their `streams`
 * row (`followersCount`), changed in the same transaction as the follow row.
 * Users without a stream row yet get it computed when their key is generated.
 */
@Injectable()
export class FollowsService {
  constructor(
    @InjectRepository(Follow) private readonly follows: Repository<Follow>,
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
  ) {}

  /** Idempotent: following twice changes nothing. */
  async follow(followerId: string, followingId: string): Promise<FollowStatus> {
    if (followerId === followingId) {
      throw new BadRequestException("You can't follow yourself");
    }
    await this.usersService.getById(followingId); // 404 if unknown
    await this.dataSource.transaction(async (manager) => {
      const inserted = await manager.query<unknown[]>(
        `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING follower_id`,
        [followerId, followingId],
      );
      if (inserted.length) {
        await manager.increment(
          Stream,
          { userId: followingId },
          'followersCount',
          1,
        );
      }
    });
    return this.status(followingId, followerId);
  }

  /** Idempotent: unfollowing someone you don't follow changes nothing. */
  async unfollow(
    followerId: string,
    followingId: string,
  ): Promise<FollowStatus> {
    await this.usersService.getById(followingId);
    await this.dataSource.transaction(async (manager) => {
      const deleted = await manager.query<[unknown[], number]>(
        `DELETE FROM follows WHERE follower_id = $1 AND following_id = $2
         RETURNING follower_id`,
        [followerId, followingId],
      );
      if (deleted[1] > 0) {
        await manager.query(
          `UPDATE streams SET followers_count = GREATEST(followers_count - 1, 0)
           WHERE user_id = $1`,
          [followingId],
        );
      }
    });
    return this.status(followingId, followerId);
  }

  async status(userId: string, viewerId?: string): Promise<FollowStatus> {
    await this.usersService.getById(userId);
    const [stream, following] = await Promise.all([
      this.dataSource.getRepository(Stream).findOne({
        where: { userId },
        select: { id: true, followersCount: true },
      }),
      viewerId && viewerId !== userId
        ? this.follows.existsBy({ followerId: viewerId, followingId: userId })
        : false,
    ]);
    return {
      following,
      // No stream row yet: count directly (it's stored once the row exists).
      followersCount:
        stream?.followersCount ??
        (await this.follows.countBy({ followingId: userId })),
    };
  }

  /** Who follows `userId`, newest first. */
  async followers(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<FollowUser>> {
    await this.usersService.getById(userId);
    const [rows, total] = await this.follows.findAndCount({
      where: { followingId: userId },
      relations: { follower: true },
      order: { createdAt: 'DESC' },
      skip: query.offset,
      take: query.limit,
    });
    return {
      items: rows.map((r) => toFollowUser(r.follower, r.createdAt)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /** Whom `userId` follows, newest first. */
  async following(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<FollowUser>> {
    await this.usersService.getById(userId);
    const [rows, total] = await this.follows.findAndCount({
      where: { followerId: userId },
      relations: { following: true },
      order: { createdAt: 'DESC' },
      skip: query.offset,
      take: query.limit,
    });
    return {
      items: rows.map((r) => toFollowUser(r.following, r.createdAt)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}

function toFollowUser(
  user: { id: string; username: string | null; firstName: string },
  since: Date,
): FollowUser {
  return {
    userId: user.id,
    username: user.username,
    firstName: user.firstName,
    since,
  };
}
