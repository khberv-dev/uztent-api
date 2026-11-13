import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity.js';

/**
 * A chat message in a live stream. `streamId` is the live session id, which
 * becomes the VOD id when the stream ends, so the chat stays with the VOD.
 * (No FK to vods: the VOD row only exists after the stream ends.)
 */
@Entity('chat_messages')
@Index(['streamId', 'createdAt'])
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  streamId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn()
  user: User;

  /** Username, or first name if none, at the time of sending. */
  @Column()
  senderName: string;

  /** Badge at the time of sending: 'streamer' | 'moderator', or null. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  senderRole: 'streamer' | 'moderator' | null;

  @Column({ type: 'varchar', length: 500 })
  text: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
