import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import { UpdateStreamDto } from './dto/update-stream.dto.js';
import { LiveStreamsService } from './live-streams.service.js';
import { StreamsService } from './streams.service.js';

@Controller('streams')
export class StreamsController {
  constructor(
    private readonly streamsService: StreamsService,
    private readonly liveStreamsService: LiveStreamsService,
  ) {}

  // Static stream settings. Declared before ':id' so "me" isn't treated as an ID.

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.streamsService.getByUser(user.id);
  }

  @Patch('me')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateStreamDto) {
    return this.streamsService.update(user.id, dto);
  }

  @Post('me/key')
  @HttpCode(HttpStatus.OK)
  generateKey(@CurrentUser() user: AuthUser) {
    return this.streamsService.generateKey(user.id);
  }

  // Live sessions (Redis). Started and ended by MediamtxWebhooksController.

  /** Public, like the stream.* WebSocket events that carry the same data. */
  @Public()
  @Get()
  list(@Query() query: PaginationQueryDto) {
    return this.liveStreamsService.list(query);
  }

  /**
   * Public: channel pages work without login.
   * A UUID is a live stream id; anything else is a username (usernames can't
   * contain '-', so they never look like a UUID).
   */
  @Public()
  @Get(':idOrUsername')
  get(@Param('idOrUsername') idOrUsername: string) {
    return isUUID(idOrUsername)
      ? this.liveStreamsService.getById(idOrUsername)
      : this.liveStreamsService.getByUsername(idOrUsername);
  }
}
