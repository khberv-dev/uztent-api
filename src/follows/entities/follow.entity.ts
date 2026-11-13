import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity.js';

/** `followerId` follows `followingId`. One row per pair. */
@Entity('follows')
@Index(['followingId', 'createdAt'])
export class Follow {
  @PrimaryColumn('uuid')
  followerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn()
  follower: User;

  @PrimaryColumn('uuid')
  followingId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn()
  following: User;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
