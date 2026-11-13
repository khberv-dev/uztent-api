import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CardsController } from './cards.controller.js';
import { CardsService } from './cards.service.js';
import { PaymentCard } from './entities/payment-card.entity.js';
import { MulticardService } from './multicard.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([PaymentCard])],
  controllers: [CardsController],
  providers: [MulticardService, CardsService],
  exports: [MulticardService, CardsService],
})
export class PaymentsModule {}
