import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../guards/jwt-auth.guard.js';

/** On @Public() routes: the caller if they sent a valid token, else undefined. */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>().user,
);
