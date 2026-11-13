import { Exclude, Expose } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity.js';

/**
 * A user's static stream configuration (one per user): where and with which
 * key their encoder (e.g. OBS) publishes. Live sessions are in Redis — see
 * LiveStreamsService.
 */
@Entity('streams')
export class Stream {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Exclude()
  @Column({ type: 'uuid', unique: true })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn()
  user: User;

  /** Copied to each live session (and its VOD) when publishing starts. */
  @Column({ default: 'Untitled stream' })
  title: string;

  /** Chat slow mode: seconds viewers must wait between messages (0 = off). */
  @Column({ type: 'int', default: 0 })
  chatSlowModeSeconds: number;

  /**
   * Users following this stream's owner. Changed with each follow / unfollow;
   * recomputed from `follows` when the key is generated.
   */
  @Column({ type: 'int', default: 0 })
  followersCount: number;

  /** Secret. Only ever returned to the owner. */
  @Column({ unique: true })
  streamKey: string;

  /** Ingest server URL, e.g. rtmp://host:1935/live. Set from STREAM_PUBLISH_URL. */
  @Column()
  publishUrl: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  /**
   * What goes in the encoder's "Stream Key" field. MediaMTX then sees path
   * `live/<id>` (public, used for HLS) and query `key=<streamKey>` (checked by
   * the auth webhook).
   */
  @Expose()
  get encoderStreamKey(): string {
    return `${this.id}?key=${this.streamKey}`;
  }
}
