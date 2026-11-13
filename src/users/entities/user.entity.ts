import { Exclude, Expose } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  /** Stored lowercase. */
  @Column({ type: 'varchar', unique: true, nullable: true })
  username: string | null;

  /** Stored lowercase. */
  @Column({ unique: true })
  email: string;

  /** scrypt hash; null until the user sets a password. */
  @Exclude()
  @Column({ type: 'varchar', nullable: true })
  password: string | null;

  @Exclude()
  @Column({ type: 'varchar', unique: true, nullable: true })
  googleId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Expose()
  get hasPassword(): boolean {
    return this.password !== null;
  }
}
