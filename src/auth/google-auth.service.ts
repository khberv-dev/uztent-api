import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

export interface GoogleProfile {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
}

@Injectable()
export class GoogleAuthService {
  private readonly client = new OAuth2Client();
  /** Web, iOS and Android each have their own client ID. */
  private readonly audience: string[];

  constructor(config: ConfigService) {
    this.audience = config
      .getOrThrow<string>('GOOGLE_CLIENT_IDS')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (this.audience.length === 0) {
      throw new Error('GOOGLE_CLIENT_IDS must contain at least one client ID');
    }
  }

  async verifyIdToken(idToken: string): Promise<GoogleProfile> {
    let payload;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.audience,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Invalid Google token');
    }

    if (!payload?.sub || !payload.email || !payload.email_verified) {
      throw new UnauthorizedException('Google account email is not verified');
    }

    return {
      googleId: payload.sub,
      email: payload.email.toLowerCase(),
      firstName:
        payload.given_name ?? payload.name ?? payload.email.split('@')[0],
      lastName: payload.family_name ?? '',
    };
  }
}
