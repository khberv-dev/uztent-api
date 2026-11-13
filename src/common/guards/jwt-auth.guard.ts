import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

export interface JwtPayload {
  sub: string;
}

export interface AuthUser {
  id: string;
}

/**
 * Registered globally (APP_GUARD in AuthModule): every route requires a valid
 * `Authorization: Bearer <access token>` unless marked with @Public().
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // APP_GUARD also runs for WebSocket messages; the socket is public
    // (chat is sent over authenticated REST), so only guard HTTP.
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];

    if (isPublic) {
      // Optional login: a valid token identifies the caller (e.g. a donor),
      // a missing or invalid one is simply ignored.
      if (scheme === 'Bearer' && token) {
        try {
          const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
          request.user = { id: payload.sub };
        } catch {
          /* anonymous */
        }
      }
      return true;
    }

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException();
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      request.user = { id: payload.sub };
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}
