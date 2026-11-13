import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { OptionalUser } from '../common/decorators/optional-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import type { MulticardCallback } from '../payments/multicard.service.js';
import { DonationsService } from './donations.service.js';
import { CreateDonationDto } from './dto/create-donation.dto.js';
import { DonationsQueryDto } from './dto/donations-query.dto.js';

@Public()
@Controller()
export class DonationsController {
  constructor(private readonly donationsService: DonationsService) {}

  /**
   * Anyone can donate. With a valid token the donor is identified (and can
   * still choose `anonymous`); without one the donation is anonymous.
   */
  @Post('streams/:idOrUsername/donations')
  create(
    @Param('idOrUsername') idOrUsername: string,
    @Body() dto: CreateDonationDto,
    @OptionalUser() user: AuthUser | undefined,
    @Ip() ip: string,
  ) {
    return this.donationsService.create(idOrUsername, user, dto, ip);
  }

  /** Paid donations of a live stream or VOD (same id). */
  @Get('streams/:id/donations')
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DonationsQueryDto,
  ) {
    return this.donationsService.listPaid(id, query.limit);
  }

  /** Status for the return page (`DONATION_RETURN_URL?donationId=…`). */
  @Get('donations/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.donationsService.getById(id);
  }
}

/** Called by Multicard after a successful payment (`callback_url`). */
@Public()
@Controller('webhooks/multicard')
export class MulticardWebhookController {
  constructor(private readonly donationsService: DonationsService) {}

  /**
   * Always HTTP 200: Multicard reads `success`. The body is typed as a plain
   * object so the global forbidNonWhitelisted pipe doesn't reject its fields.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  callback(@Body() body: Record<string, unknown>) {
    const required = ['store_id', 'amount', 'invoice_id', 'uuid', 'sign'];
    if (required.some((field) => body[field] === undefined)) {
      return { success: false, message: 'Missing fields' };
    }
    return this.donationsService.handleCallback(
      body as unknown as MulticardCallback,
    );
  }
}
