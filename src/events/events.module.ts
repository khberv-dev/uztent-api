import { Global, Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway.js';
import { EventsService } from './events.service.js';

@Global()
@Module({
  providers: [EventsService, EventsGateway],
  exports: [EventsService],
})
export class EventsModule {}
