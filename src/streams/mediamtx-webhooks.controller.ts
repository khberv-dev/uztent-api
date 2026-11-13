import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator.js';
import { IpAllowlistGuard } from '../common/guards/ip-allowlist.guard.js';
import { MediamtxAuthDto } from './dto/mediamtx-auth.dto.js';
import { MediamtxPathDto } from './dto/mediamtx-path.dto.js';
import type { Stream } from './entities/stream.entity.js';
import { LiveStreamsService } from './live-streams.service.js';
import { StreamsService } from './streams.service.js';

/**
 * Bodies are typed as plain objects so the global ValidationPipe
 * (forbidNonWhitelisted) skips them; these pipes validate the fields we use
 * and drop everything else MediaMTX sends.
 */
const authBody = new ValidationPipe({
  whitelist: true,
  expectedType: MediamtxAuthDto,
});
const pathBody = new ValidationPipe({
  whitelist: true,
  expectedType: MediamtxPathDto,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rendition paths written by the transcoder in mediamtx.yml. */
const INTERNAL_PUBLISH_PATH = /^watch\//;
/** `ip` in MediaMTX's auth request = the connecting client, as MediaMTX sees it. */
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Called by MediaMTX, not by users: no JWT, IP allowlist instead.
 *
 * Encoders publish to `<publishUrl>/<streamId>?key=<streamKey>`, so the
 * MediaMTX path is `live/<streamId>` and HLS is served under the stream ID,
 * never the secret key.
 */
@Public()
@UseGuards(IpAllowlistGuard)
@Controller('webhooks/mediamtx')
export class MediamtxWebhooksController {
  constructor(
    private readonly streamsService: StreamsService,
    private readonly liveStreamsService: LiveStreamsService,
  ) {}

  /** `authHTTPAddress`: allow reads; allow publish only with the right key. */
  @Post('auth')
  @HttpCode(HttpStatus.NO_CONTENT)
  async auth(@Body(authBody) body: Record<string, unknown>) {
    const req = body as unknown as MediamtxAuthDto;

    if (req.action === 'read' || req.action === 'playback') return;
    if (req.action !== 'publish') {
      throw new ForbiddenException(`Action "${req.action}" is not allowed`);
    }

    // MediaMTX's own transcoder (runOnAvailable ffmpeg) republishes renditions
    // to watch/<streamId>/<quality> from the MediaMTX host itself.
    if (
      INTERNAL_PUBLISH_PATH.test(req.path ?? '') &&
      LOOPBACK_IPS.has(req.ip ?? '')
    ) {
      return;
    }

    const stream = await this.findStream(req.path);
    // The key comes from `?key=`; `?pass=` (password) and Bearer tokens also work.
    const key =
      new URLSearchParams(req.query ?? '').get('key') ??
      req.password ??
      req.token;

    if (!stream || !key || !this.streamsService.isValidKey(stream, key)) {
      throw new UnauthorizedException('Invalid stream key');
    }
  }

  /** `runOnOnline`: the publisher is live — start a live session. */
  @Post('online')
  @HttpCode(HttpStatus.NO_CONTENT)
  async online(@Body(pathBody) body: Record<string, unknown>) {
    const stream = await this.getStream(body);
    await this.liveStreamsService.start({
      userId: stream.userId,
      streamId: stream.id,
      title: stream.title,
      chatSlowModeSeconds: stream.chatSlowModeSeconds,
    });
  }

  /** `runOnOffline`: the publisher left — end the session and save the VOD. */
  @Post('offline')
  @HttpCode(HttpStatus.NO_CONTENT)
  async offline(@Body(pathBody) body: Record<string, unknown>) {
    const stream = await this.getStream(body);
    await this.liveStreamsService.end(stream.userId);
  }

  private async getStream(body: Record<string, unknown>): Promise<Stream> {
    const { path } = body as unknown as MediamtxPathDto;
    const stream = await this.findStream(path);
    if (!stream) throw new NotFoundException('Unknown stream path');
    return stream;
  }

  /** `live/<streamId>` → Stream. */
  private async findStream(path: string | undefined): Promise<Stream | null> {
    const streamId = path?.split('/').pop();
    if (!streamId || !UUID.test(streamId)) return null;
    return this.streamsService.findById(streamId);
  }
}
