import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import { ChatService } from './chat.service.js';
import { ChatHistoryQueryDto } from './dto/chat-history-query.dto.js';
import { ChatUserDto } from './dto/chat-user.dto.js';
import { SendMessageDto } from './dto/send-message.dto.js';

@Controller('streams')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // ---- The caller's own channel (streamer settings) ------------------------
  // Two segments, so no clash with ':id/chat'.

  @Get('me/bans')
  listBans(@CurrentUser() user: AuthUser) {
    return this.chatService.listBans(user.id);
  }

  @Post('me/bans')
  @HttpCode(HttpStatus.NO_CONTENT)
  ban(@CurrentUser() user: AuthUser, @Body() dto: ChatUserDto) {
    return this.chatService.ban(user.id, user.id, dto.userId);
  }

  @Delete('me/bans/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  unban(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.chatService.unban(user.id, userId);
  }

  @Get('me/moderators')
  listModerators(@CurrentUser() user: AuthUser) {
    return this.chatService.listModerators(user.id);
  }

  @Post('me/moderators')
  @HttpCode(HttpStatus.NO_CONTENT)
  addModerator(@CurrentUser() user: AuthUser, @Body() dto: ChatUserDto) {
    return this.chatService.addModerator(user.id, dto.userId);
  }

  @Delete('me/moderators/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeModerator(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.chatService.removeModerator(user.id, userId);
  }

  // ---- Chat of one stream (live stream id = VOD id) ------------------------

  @Public()
  @Get(':id/chat')
  history(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ChatHistoryQueryDto,
  ) {
    return this.chatService.history(id, query);
  }

  @Get(':id/chat/me')
  permissions(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.chatService.permissions(id, user.id);
  }

  @Post(':id/chat')
  send(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.send(id, user.id, dto.text);
  }

  /** Streamer or moderator. */
  @Delete(':id/chat/:messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.chatService.delete(id, messageId, user.id);
  }

  /** Streamer or moderator: ban from all of the stream owner's chats. */
  @Post(':id/chat/bans')
  @HttpCode(HttpStatus.NO_CONTENT)
  banInStream(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChatUserDto,
  ) {
    return this.chatService.banInStream(id, user.id, dto.userId);
  }

  /** Streamer or moderator. */
  @Delete(':id/chat/bans/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  unbanInStream(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.chatService.unbanInStream(id, user.id, userId);
  }
}
