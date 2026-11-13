import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import { VodsService } from './vods.service.js';

@Controller('vods')
export class VodsController {
  constructor(private readonly vodsService: VodsService) {}

  // Declared before ':id' so "me" isn't treated as an ID.
  @Get('me')
  listMine(@CurrentUser() user: AuthUser, @Query() query: PaginationQueryDto) {
    return this.vodsService.listByUser(user.id, query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.vodsService.getById(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.vodsService.delete(id, user.id);
  }
}

@Controller('users/:userId/vods')
export class UserVodsController {
  constructor(private readonly vodsService: VodsService) {}

  @Get()
  list(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.vodsService.listByUser(userId, query);
  }
}
