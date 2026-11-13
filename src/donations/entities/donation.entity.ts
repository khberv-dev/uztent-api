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

export type DonationStatus = 'pending' | 'paid' | 'failed';

/**
 * A donation to a live stream. `id` is sent to Multicard as `invoice_id`.
 * `streamId` is the live stream id (= VOD id after the stream ends).
 */
@Entity('donations')
@Index(['streamId', 'paidAt'])
export class Donation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  streamId: string;

  /** The streamer receiving the donation. */
  @Column({ type: 'uuid' })
  streamerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn()
  streamer: User;

  /** Logged-in donor; null for guests. Kept even when `anonymous`. */
  @Column({ type: 'uuid', nullable: true })
  donorId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn()
  donor: User | null;

  /** Hide the donor's name publicly. Always true for guests. */
  @Column({ default: false })
  anonymous: boolean;

  /** Username or first name at donation time; null when anonymous. */
  @Column({ type: 'varchar', nullable: true })
  donorName: string | null;

  /** In so'm. */
  @Column({ type: 'int' })
  amount: number;

  @Column({ type: 'varchar', length: 200, nullable: true })
  message: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: DonationStatus;

  /** Multicard transaction uuid. */
  @Column({ type: 'varchar', unique: true, nullable: true })
  multicardUuid: string | null;

  /** Multicard payment page (app.rhmt.uz). */
  @Column({ type: 'varchar', nullable: true })
  checkoutUrl: string | null;

  /** Unpaid invoices are cancelled by Multicard after this. */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  /** Payment system reported by Multicard (uzcard, humo, …). */
  @Column({ type: 'varchar', nullable: true })
  paymentSystem: string | null;

  @Column({ type: 'varchar', nullable: true })
  receiptUrl: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
