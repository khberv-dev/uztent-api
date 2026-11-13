import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity.js';

/** A recorded stream. `id` is the ID of the stream it was recorded from. */
@Entity('vods')
export class Vod {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn()
  user: User;

  @Column()
  title: string;

  /** Filled in later by the media pipeline. */
  @Column({ type: 'varchar', nullable: true })
  previewUri: string | null;

  /** Filled in later by the media pipeline. */
  @Column({ type: 'varchar', nullable: true })
  videoUri: string | null;

  @Column({ type: 'int', default: 0 })
  peakViewers: number;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz' })
  endedAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
