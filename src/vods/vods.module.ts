import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatMessage } from '../chat/entities/chat-message.entity.js';
import { Vod } from './entities/vod.entity.js';
import { UserVodsController, VodsController } from './vods.controller.js';
import { VodsService } from './vods.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Vod, ChatMessage])],
  controllers: [VodsController, UserVodsController],
  providers: [VodsService],
  exports: [VodsService],
})
export class VodsModule {}
