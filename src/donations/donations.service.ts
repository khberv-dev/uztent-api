import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import type { Redis } from 'ioredis';
import { Not, Repository } from 'typeorm';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import { EventsService } from '../events/events.service.js';
import {
  MulticardService,
  type MulticardCallback,
} from '../payments/multicard.service.js';
import { REDIS } from '../shared/redis/redis.module.js';
import { LiveStreamsService } from '../streams/live-streams.service.js';
import { UsersService } from '../users/users.service.js';
import type { CreateDonationDto } from './dto/create-donation.dto.js';
import { Donation } from './entities/donation.entity.js';

/** Public shape of a donation. `expired` = unpaid past the invoice lifetime. */
export interface DonationView {
  id: string;
  streamId: string;
  donorName: string | null;
  anonymous: boolean;
  amount: number;
  message: string | null;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  /** Only while pending: the Multicard (app.rhmt.uz) payment page. */
  checkoutUrl: string | null;
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
    clientIp: string,
  ): Promise<DonationView> {
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
    await this.rateLimit(donor ? `user:${donor.id}` : `ip:${clientIp}`);

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
        expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      }),
    );

    const tiyin = dto.amount * 100;
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

    const paidAt = parsePaymentTime(body.payment_time);
    const result = await this.donations.update(
      { id: donation.id, status: Not('paid') },
      {
        status: 'paid',
        paidAt,
        multicardUuid: body.uuid,
        paymentSystem: body.ps ?? null,
        receiptUrl: body.receipt_url ?? null,
      },
    );
    // 0 rows: a concurrent callback already marked it paid (and announced it).
    if (result.affected === 1) {
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
    return { success: true };
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

function toView(d: Donation): DonationView {
  const expired = d.status === 'pending' && d.expiresAt.getTime() < Date.now();
  return {
    id: d.id,
    streamId: d.streamId,
    donorName: d.anonymous ? null : d.donorName,
    anonymous: d.anonymous,
    amount: d.amount,
    message: d.message,
    status: expired ? 'expired' : d.status,
    checkoutUrl: d.status === 'pending' && !expired ? d.checkoutUrl : null,
    expiresAt: d.expiresAt,
    paidAt: d.paidAt,
    createdAt: d.createdAt,
  };
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
