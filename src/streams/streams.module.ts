import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module.js';
import { VodsModule } from '../vods/vods.module.js';
import { Stream } from './entities/stream.entity.js';
import { LiveStreamsService } from './live-streams.service.js';
import { MediamtxWebhooksController } from './mediamtx-webhooks.controller.js';
import { StreamsController } from './streams.controller.js';
import { StreamsService } from './streams.service.js';
import { ViewerCounterService } from './viewer-counter.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Stream]), UsersModule, VodsModule],
  controllers: [StreamsController, MediamtxWebhooksController],
  providers: [StreamsService, LiveStreamsService, ViewerCounterService],
  exports: [LiveStreamsService],
})
export class StreamsModule {}
