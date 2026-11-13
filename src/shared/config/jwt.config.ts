import type { ConfigService } from '@nestjs/config';
import type { JwtModuleOptions } from '@nestjs/jwt';

export function jwtConfig(config: ConfigService): JwtModuleOptions {
  return {
    secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    signOptions: {
      // seconds
      expiresIn: Number(config.getOrThrow('JWT_ACCESS_TTL')),
    },
  };
}
