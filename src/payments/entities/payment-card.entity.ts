import { Exclude } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity.js';

/**
 * A card the user bound through Multicard's form. We never see the card
 * number: only Multicard's token (secret) and the masked PAN.
 */
@Entity('payment_cards')
export class PaymentCard {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Exclude()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn()
  user: User;

  /** Multicard card token: charges the card. Never returned. */
  @Exclude()
  @Column({ unique: true })
  cardToken: string;

  /** Masked number, e.g. 986027******1519. */
  @Column()
  cardPan: string;

  /** uzcard, humo, visa, mastercard, unionpay. */
  @Column({ type: 'varchar', nullable: true })
  ps: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
