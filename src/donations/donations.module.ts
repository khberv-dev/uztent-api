import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsModule } from '../payments/payments.module.js';
import { StreamsModule } from '../streams/streams.module.js';
import { UsersModule } from '../users/users.module.js';
import {
  DonationsController,
  MulticardWebhookController,
} from './donations.controller.js';
import { DonationsService } from './donations.service.js';
import { Donation } from './entities/donation.entity.js';
import { MonetizationController } from './monetization.controller.js';
import { MonetizationService } from './monetization.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Donation]),
    PaymentsModule,
    StreamsModule,
    UsersModule,
  ],
  controllers: [
    DonationsController,
    MulticardWebhookController,
    MonetizationController,
  ],
  providers: [DonationsService, MonetizationService],
})
export class DonationsModule {}
