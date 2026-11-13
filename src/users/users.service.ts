import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../common/utils/is-unique-violation.js';
import type { UpdateUserDto } from './dto/update-user.dto.js';
import { User } from './entities/user.entity.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.users.findOneBy({ id });
  }

  async getById(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  findByEmail(email: string): Promise<User | null> {
    return this.users.findOneBy({ email: email.toLowerCase() });
  }

  findByUsername(username: string): Promise<User | null> {
    return this.users.findOneBy({ username: username.toLowerCase() });
  }

  /** A user's own current username counts as available to them. */
  async isUsernameAvailable(username: string, userId: string) {
    const owner = await this.findByUsername(username);
    return !owner || owner.id === userId;
  }

  findByGoogleId(googleId: string): Promise<User | null> {
    return this.users.findOneBy({ googleId });
  }

  create(data: Pick<User, 'firstName' | 'lastName' | 'email'> & Partial<User>) {
    return this.users.save(
      this.users.create({ ...data, email: data.email.toLowerCase() }),
    );
  }

  save(user: User): Promise<User> {
    return this.users.save(user);
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.getById(id);
    Object.assign(user, dto);
    try {
      return await this.users.save(user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Username is already taken');
      }
      throw error;
    }
  }
}
