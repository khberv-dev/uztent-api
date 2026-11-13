import { Module } from '@nestjs/common';
import { MulticardService } from './multicard.service.js';

@Module({
  providers: [MulticardService],
  exports: [MulticardService],
})
export class PaymentsModule {}
