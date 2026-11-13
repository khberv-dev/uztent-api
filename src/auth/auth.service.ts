import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import dayjs from 'dayjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Repository } from 'typeorm';
import type { JwtPayload } from '../common/guards/jwt-auth.guard.js';
import { User } from '../users/entities/user.entity.js';
import { UsersService } from '../users/users.service.js';
import type { LoginDto } from './dto/login.dto.js';
import type { SetPasswordDto } from './dto/set-password.dto.js';
import { RefreshToken } from './entities/refresh-token.entity.js';
import { GoogleAuthService } from './google-auth.service.js';
import { PasswordService } from './password.service.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse extends AuthTokens {
  user: User;
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthService {
  private readonly refreshTtlDays: number;

  constructor(
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly jwtService: JwtService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    config: ConfigService,
  ) {
    this.refreshTtlDays = Number(config.getOrThrow('REFRESH_TOKEN_TTL_DAYS'));
  }

  /** Finds the user by Google ID, links by verified email, or creates one. */
  async loginWithGoogle(idToken: string): Promise<AuthResponse> {
    const profile = await this.googleAuthService.verifyIdToken(idToken);

    let user = await this.usersService.findByGoogleId(profile.googleId);
    if (!user) {
      user = await this.usersService.findByEmail(profile.email);
      if (user) {
        user.googleId = profile.googleId;
        user = await this.usersService.save(user);
      } else {
        user = await this.usersService.create(profile);
      }
    }

    return this.issue(user);
  }

  async login({ login, password }: LoginDto): Promise<AuthResponse> {
    const user = login.includes('@')
      ? await this.usersService.findByEmail(login)
      : await this.usersService.findByUsername(login);

    if (
      !user?.password ||
      !(await this.passwordService.verify(password, user.password))
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issue(user);
  }

  /** Rotates the refresh token: the old one is revoked, a new pair is issued. */
  async refresh(refreshToken: string): Promise<AuthResponse> {
    const stored = await this.findRefreshToken(refreshToken);
    if (!stored || dayjs(stored.expiresAt).isBefore(dayjs())) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    await this.refreshTokens.delete(stored.id);

    const user = await this.usersService.findById(stored.userId);
    if (!user) throw new UnauthorizedException('Invalid refresh token');
    return this.issue(user);
  }

  async logout(refreshToken: string): Promise<void> {
    const stored = await this.findRefreshToken(refreshToken);
    if (stored) await this.refreshTokens.delete(stored.id);
  }

  /**
   * Sets the first password, or changes it (current password required).
   * Revokes every session and returns a fresh pair for the caller.
   */
  async setPassword(
    userId: string,
    { currentPassword, newPassword }: SetPasswordDto,
  ): Promise<AuthResponse> {
    const user = await this.usersService.getById(userId);

    if (user.password) {
      if (!currentPassword) {
        throw new BadRequestException('currentPassword is required');
      }
      if (
        !(await this.passwordService.verify(currentPassword, user.password))
      ) {
        throw new UnauthorizedException('Current password is incorrect');
      }
    }

    user.password = await this.passwordService.hash(newPassword);
    await this.usersService.save(user);
    await this.refreshTokens.delete({ userId: user.id });

    return this.issue(user);
  }

  private async issue(user: User): Promise<AuthResponse> {
    const payload: JwtPayload = { sub: user.id };
    const accessToken = await this.jwtService.signAsync(payload);

    const secret = randomBytes(32).toString('base64url');
    const stored = await this.refreshTokens.save(
      this.refreshTokens.create({
        userId: user.id,
        tokenHash: sha256(secret),
        expiresAt: dayjs().add(this.refreshTtlDays, 'day').toDate(),
      }),
    );

    return { accessToken, refreshToken: `${stored.id}.${secret}`, user };
  }

  private async findRefreshToken(token: string): Promise<RefreshToken | null> {
    const [id, secret] = token.split('.');
    if (!id || !secret || !/^[0-9a-f-]{36}$/i.test(id)) return null;

    const stored = await this.refreshTokens.findOneBy({ id });
    if (!stored) return null;

    const matches = timingSafeEqual(
      Buffer.from(stored.tokenHash, 'hex'),
      Buffer.from(sha256(secret), 'hex'),
    );
    return matches ? stored : null;
  }
}
