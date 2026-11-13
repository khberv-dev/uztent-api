import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { OptionalUser } from '../common/decorators/optional-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import { FollowsService } from './follows.service.js';

@Controller('users/:userId')
export class FollowsController {
  constructor(private readonly followsService: FollowsService) {}

  @Post('follow')
  follow(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.followsService.follow(user.id, userId);
  }

  @Delete('follow')
  unfollow(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.followsService.unfollow(user.id, userId);
  }

  /** Public: followers count, plus whether the caller follows (if signed in). */
  @Public()
  @Get('follow')
  status(
    @OptionalUser() user: AuthUser | undefined,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.followsService.status(userId, user?.id);
  }

  @Public()
  @Get('followers')
  followers(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.followsService.followers(userId, query);
  }

  @Public()
  @Get('following')
  following(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.followsService.following(userId, query);
  }
}
