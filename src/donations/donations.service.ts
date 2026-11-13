import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import type { Redis } from 'ioredis';
import { Not, Repository } from 'typeorm';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import { EventsService } from '../events/events.service.js';
import { CardsService } from '../payments/cards.service.js';
import {
  MulticardRejection,
  MulticardService,
  type MulticardCallback,
  type MulticardPayment,
} from '../payments/multicard.service.js';
import { REDIS } from '../shared/redis/redis.module.js';
import { LiveStreamsService } from '../streams/live-streams.service.js';
import { UsersService } from '../users/users.service.js';
import type { CreateDonationDto } from './dto/create-donation.dto.js';
import { Donation, type PaymentMethod } from './entities/donation.entity.js';

/** Multicard confirm errors meaning "the outcome is unknown: check status". */
const PENDING_CODES = new Set([
  'ERROR_DEBIT_UNKNOWN',
  'ERROR_CALLBACK_TIMEOUT',
]);
const WRONG_OTP = 'ERROR_WRONG_OTP';

export interface DonorContext {
  ip: string;
  userAgent: string;
}

/** Public shape of a donation. `expired` = unpaid past the invoice lifetime. */
export interface DonationView {
  id: string;
  streamId: string;
  donorName: string | null;
  anonymous: boolean;
  amount: number;
  message: string | null;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  paymentMethod: PaymentMethod;
  /** Only while pending: the Multicard (app.rhmt.uz) payment page. */
  checkoutUrl: string | null;
  /** Card payment waiting for the SMS code: POST /donations/:id/confirm. */
  otpRequired: boolean;
  expiresAt: Date;
  paidAt: Date | null;
  createdAt: Date;
}

/** Reply to Multicard: anything but success:true cancels and refunds the payment. */
export interface CallbackReply {
  success: boolean;
  message?: string;
}

@Injectable()
export class DonationsService {
  private readonly logger = new Logger(DonationsService.name);
  private readonly minSom: number;
  private readonly maxSom: number;
  private readonly ttlSeconds: number;
  private readonly perMinute: number;
  private readonly callbackUrl: string;
  private readonly returnUrl: string;

  constructor(
    @InjectRepository(Donation)
    private readonly donations: Repository<Donation>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly multicard: MulticardService,
    private readonly cardsService: CardsService,
    private readonly liveStreamsService: LiveStreamsService,
    private readonly usersService: UsersService,
    private readonly eventsService: EventsService,
    config: ConfigService,
  ) {
    this.minSom = Number(config.getOrThrow('DONATION_MIN_SOM'));
    this.maxSom = Number(config.getOrThrow('DONATION_MAX_SOM'));
    this.ttlSeconds = Number(config.getOrThrow('DONATION_INVOICE_TTL_SECONDS'));
    this.perMinute = Number(config.getOrThrow('DONATION_INVOICES_PER_MINUTE'));
    this.callbackUrl = config.getOrThrow<string>('MULTICARD_CALLBACK_URL');
    this.returnUrl = config.getOrThrow<string>('DONATION_RETURN_URL');
  }

  /**
   * Resolves the live stream, saves a pending donation and creates the
   * Multicard invoice (invoice_id = donation id). Returns the checkout URL.
   */
  async create(
    idOrUsername: string,
    donor: AuthUser | undefined,
    dto: CreateDonationDto,
    client: DonorContext,
  ): Promise<DonationView> {
    if (dto.cardId && !donor) {
      throw new UnauthorizedException('Sign in to pay with a saved card');
    }
    const stream = isUUID(idOrUsername)
      ? await this.liveStreamsService.getById(idOrUsername)
      : await this.liveStreamsService.getByUsername(idOrUsername);

    if (donor?.id === stream.userId) {
      throw new BadRequestException("You can't donate to your own stream");
    }
    if (dto.amount < this.minSom || dto.amount > this.maxSom) {
      throw new BadRequestException(
        `amount must be between ${this.minSom} and ${this.maxSom} so'm`,
      );
    }
    const card =
      dto.cardId && donor
        ? await this.cardsService.getOwned(donor.id, dto.cardId)
        : null;
    await this.rateLimit(donor ? `user:${donor.id}` : `ip:${client.ip}`);

    const anonymous = !donor || dto.anonymous === true;
    let donorName: string | null = null;
    if (donor && !anonymous) {
      const user = await this.usersService.getById(donor.id);
      donorName = user.username ?? user.firstName;
    }

    const donation = await this.donations.save(
      this.donations.create({
        streamId: stream.id,
        streamerId: stream.userId,
        donorId: donor?.id ?? null,
        anonymous,
        donorName,
        amount: dto.amount,
        message: dto.message ?? null,
        status: 'pending',
        paymentMethod: card ? 'card' : 'checkout',
        cardId: card?.id ?? null,
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      }),
    );

    const tiyin = dto.amount * 100;
    if (card) {
      let payment: MulticardPayment;
      try {
        payment = await this.multicard.createTokenPayment({
          cardToken: card.cardToken,
          amount: tiyin,
          invoiceId: donation.id,
          callbackUrl: this.callbackUrl,
          ip: client.ip,
          userAgent: client.userAgent,
        });
      } catch (error) {
        donation.status = 'failed';
        await this.donations.save(donation);
        throw declined(error);
      }
      donation.multicardUuid = payment.uuid;
      donation.awaitingOtp = payment.otpHash !== null;
      await this.donations.save(donation);
      // No SMS code needed: debit the card now.
      if (!donation.awaitingOtp) await this.confirmCard(donation);
      return toView(donation);
    }

    try {
      const invoice = await this.multicard.createInvoice({
        invoiceId: donation.id,
        amount: tiyin,
        callbackUrl: this.callbackUrl,
        returnUrl: withQuery(this.returnUrl, { donationId: donation.id }),
        lang: dto.lang,
        ttl: this.ttlSeconds,
      });
      donation.multicardUuid = invoice.uuid;
      donation.checkoutUrl = invoice.checkoutUrl;
    } catch (error) {
      donation.status = 'failed';
      await this.donations.save(donation);
      throw error;
    }
    await this.donations.save(donation);
    return toView(donation);
  }

  async getById(id: string): Promise<DonationView> {
    const donation = await this.donations.findOneBy({ id });
    if (!donation) throw new NotFoundException('Donation not found');
    await this.syncCardPayment(donation);
    return toView(donation);
  }

  /** Completes a card payment that needs the SMS code. Donor only. */
  async confirm(id: string, donorId: string, otp: string) {
    const donation = await this.donations.findOneBy({ id, donorId });
    if (!donation) throw new NotFoundException('Donation not found');
    if (
      donation.status !== 'pending' ||
      !donation.awaitingOtp ||
      !donation.multicardUuid
    ) {
      throw new BadRequestException("This donation doesn't need confirmation");
    }
    if (donation.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This donation has expired');
    }
    await this.confirmCard(donation, otp);
    return toView(donation);
  }

  /** Paid donations of a stream (live or VOD id), newest first. */
  async listPaid(streamId: string, limit: number): Promise<DonationView[]> {
    const rows = await this.donations.find({
      where: { streamId, status: 'paid' },
      order: { paidAt: 'DESC' },
      take: limit,
    });
    return rows.map(toView);
  }

  /**
   * Multicard success callback. Idempotent: a repeated callback for the same
   * payment answers success again but marks and announces the donation once.
   */
  async handleCallback(body: MulticardCallback): Promise<CallbackReply> {
    if (!this.multicard.verifyCallback(body)) {
      this.logger.warn(`Callback with bad signature for ${body.invoice_id}`);
      return { success: false, message: 'Invalid signature' };
    }
    if (String(body.store_id) !== this.multicard.storeId) {
      return { success: false, message: 'Unknown store' };
    }

    const donation = isUUID(body.invoice_id)
      ? await this.donations.findOneBy({ id: body.invoice_id })
      : null;
    if (!donation) return { success: false, message: 'Invoice not found' };

    if (Number(body.amount) !== donation.amount * 100) {
      return { success: false, message: 'Amount mismatch' };
    }
    if (donation.status === 'paid') {
      // Same payment again: fine. A different payment for a paid invoice: refund it.
      return donation.multicardUuid === body.uuid
        ? { success: true }
        : { success: false, message: 'Invoice already paid' };
    }

    await this.markPaid(donation, {
      uuid: body.uuid,
      paymentTime: body.payment_time ?? null,
      ps: body.ps ?? null,
      receiptUrl: body.receipt_url ?? null,
    });
    return { success: true };
  }

  /**
   * PUT /payment/:uuid (empty body, or the OTP). Updates `donation` in place.
   * Wrong OTP keeps it pending; an unknown outcome is settled by the callback
   * or by syncCardPayment; any other rejection fails it.
   */
  private async confirmCard(donation: Donation, otp?: string): Promise<void> {
    let payment: MulticardPayment;
    try {
      payment = await this.multicard.confirmPayment(
        donation.multicardUuid!,
        otp,
      );
    } catch (error) {
      if (error instanceof MulticardRejection) {
        if (error.code === WRONG_OTP) {
          throw new BadRequestException('Wrong confirmation code');
        }
        if (PENDING_CODES.has(error.code)) return;
        await this.markFailed(donation);
      }
      throw declined(error);
    }
    await this.applyPayment(donation, payment);
  }

  /** Pending card payment: ask Multicard (at most every 3 s per donation). */
  private async syncCardPayment(donation: Donation): Promise<void> {
    if (
      donation.status !== 'pending' ||
      donation.paymentMethod !== 'card' ||
      !donation.multicardUuid ||
      donation.awaitingOtp
    ) {
      return;
    }
    const fresh = await this.redis.set(
      `donation:sync:${donation.id}`,
      '1',
      'EX',
      3,
      'NX',
    );
    if (!fresh) return;
    try {
      await this.applyPayment(
        donation,
        await this.multicard.getPayment(donation.multicardUuid),
      );
    } catch (error) {
      this.logger.warn(`Sync of ${donation.id} failed: ${String(error)}`);
    }
  }

  private async applyPayment(donation: Donation, payment: MulticardPayment) {
    if (payment.status === 'success') {
      await this.markPaid(donation, payment);
    } else if (payment.status === 'error' || payment.status === 'revert') {
      await this.markFailed(donation);
    }
  }

  /**
   * Conditional update, so concurrent callers (callback, confirm, sync) mark
   * and announce a donation exactly once. Updates `donation` in place.
   */
  private async markPaid(
    donation: Donation,
    payment: Pick<
      MulticardPayment,
      'uuid' | 'paymentTime' | 'ps' | 'receiptUrl'
    >,
  ): Promise<void> {
    const paidAt = parsePaymentTime(payment.paymentTime ?? undefined);
    const changes = {
      status: 'paid' as const,
      paidAt,
      awaitingOtp: false,
      multicardUuid: payment.uuid,
      paymentSystem: payment.ps,
      receiptUrl: payment.receiptUrl,
    };
    const result = await this.donations.update(
      { id: donation.id, status: Not('paid') },
      changes,
    );
    if (result.affected !== 1) {
      // Someone else marked it paid first: reflect the stored state.
      Object.assign(
        donation,
        await this.donations.findOneBy({ id: donation.id }),
      );
      return;
    }
    Object.assign(donation, changes);
    await this.eventsService.publish({
      event: 'donation.received',
      data: {
        id: donation.id,
        streamId: donation.streamId,
        donorName: donation.anonymous ? null : donation.donorName,
        amount: donation.amount,
        message: donation.message,
        paidAt: paidAt.toISOString(),
      },
    });
  }

  private async markFailed(donation: Donation): Promise<void> {
    await this.donations.update(
      { id: donation.id, status: 'pending' },
      { status: 'failed', awaitingOtp: false },
    );
    Object.assign(
      donation,
      await this.donations.findOneBy({ id: donation.id }),
    );
  }

  /** At most DONATION_INVOICES_PER_MINUTE new invoices per user (or IP). */
  private async rateLimit(who: string) {
    const key = `donation:rate:${who}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 60);
    if (count > this.perMinute) {
      throw new HttpException(
        'Too many donation requests, try again in a minute',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

export function toView(d: Donation): DonationView {
  const expired = d.status === 'pending' && d.expiresAt.getTime() < Date.now();
  return {
    id: d.id,
    streamId: d.streamId,
    donorName: d.anonymous ? null : d.donorName,
    anonymous: d.anonymous,
    amount: d.amount,
    message: d.message,
    status: expired ? 'expired' : d.status,
    paymentMethod: d.paymentMethod,
    checkoutUrl: d.status === 'pending' && !expired ? d.checkoutUrl : null,
    otpRequired: d.status === 'pending' && !expired && d.awaitingOtp,
    expiresAt: d.expiresAt,
    paidAt: d.paidAt,
    createdAt: d.createdAt,
  };
}

/** A card payment Multicard refused: 402 with its error code. */
function declined(error: unknown): unknown {
  if (!(error instanceof MulticardRejection)) return error;
  return new HttpException(
    {
      statusCode: HttpStatus.PAYMENT_REQUIRED,
      message: 'Payment was declined',
      error: 'Payment Required',
      reason: error.code,
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

function withQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** Multicard sends "YYYY-mm-dd H:i:s" in GMT+5; fall back to now. */
function parsePaymentTime(value: string | undefined): Date {
  const m = value?.match(/^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return new Date();
  const date = new Date(
    `${m[1]}T${m[2].padStart(2, '0')}:${m[3]}:${m[4]}+05:00`,
  );
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
