import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { OptionalUser } from '../common/decorators/optional-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import type { MulticardCallback } from '../payments/multicard.service.js';
import { DonationsService } from './donations.service.js';
import {
  ConfirmDonationDto,
  CreateDonationDto,
} from './dto/create-donation.dto.js';
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
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.donationsService.create(idOrUsername, user, dto, {
      ip,
      userAgent: userAgent ?? 'unknown',
    });
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

  /** SMS code for a card payment (`otpRequired: true`). Donor only. */
  @Post('donations/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @OptionalUser() user: AuthUser | undefined,
    @Body() dto: ConfirmDonationDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.donationsService.confirm(id, user.id, dto.otp);
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
