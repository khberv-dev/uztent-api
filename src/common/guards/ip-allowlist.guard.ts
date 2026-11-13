import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { BlockList, isIP } from 'node:net';

/**
 * Allows a request only if the caller's IP matches WEBHOOK_ALLOWED_IPS:
 * comma-separated addresses or CIDR masks, IPv4 or IPv6,
 * e.g. `127.0.0.1,::1,10.0.0.0/8`.
 *
 * Uses the socket address (`req.ip`); if the API sits behind a reverse proxy,
 * Express's `trust proxy` must be set or the proxy's IP is what gets checked.
 */
@Injectable()
export class IpAllowlistGuard implements CanActivate {
  private readonly allowlist = new BlockList();

  constructor(config: ConfigService) {
    const entries = config
      .getOrThrow<string>('WEBHOOK_ALLOWED_IPS')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length === 0) {
      throw new Error('WEBHOOK_ALLOWED_IPS must contain at least one entry');
    }

    for (const entry of entries) {
      const [address, prefix] = entry.split('/');
      const version = isIP(address);
      if (!version) {
        throw new Error(`WEBHOOK_ALLOWED_IPS: invalid address "${entry}"`);
      }
      const type = version === 4 ? 'ipv4' : 'ipv6';
      if (prefix === undefined) {
        this.allowlist.addAddress(address, type);
      } else {
        this.allowlist.addSubnet(address, Number(prefix), type);
      }
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // IPv4 clients on a dual-stack socket show up as ::ffff:a.b.c.d.
    const ip = (request.ip ?? '').replace(
      /^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/,
      '',
    );
    const version = isIP(ip);

    if (
      !version ||
      !this.allowlist.check(ip, version === 4 ? 'ipv4' : 'ipv6')
    ) {
      throw new ForbiddenException('IP not allowed');
    }
    return true;
  }
}
