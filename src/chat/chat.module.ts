import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StreamsModule } from '../streams/streams.module.js';
import { UsersModule } from '../users/users.module.js';
import { VodsModule } from '../vods/vods.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { ChatBan } from './entities/chat-ban.entity.js';
import { ChatMessage } from './entities/chat-message.entity.js';
import { ChatModerator } from './entities/chat-moderator.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatMessage, ChatBan, ChatModerator]),
    StreamsModule,
    UsersModule,
    VodsModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
