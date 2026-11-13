import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  And,
  type FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import type { Paginated } from '../common/dto/pagination.dto.js';
import { LiveStreamsService } from '../streams/live-streams.service.js';
import { type DonationView, toView } from './donations.service.js';
import type {
  DailyQueryDto,
  MonetizationDonationsQueryDto,
  TimeRangeQueryDto,
  TopDonorsQueryDto,
} from './dto/monetization-query.dto.js';
import { Donation } from './entities/donation.entity.js';

/** Uzbekistan is UTC+5 all year (no DST). */
const TZ = 'Asia/Tashkent';
const TZ_OFFSET_MS = 5 * 3600_000;
const DAY_MS = 86_400_000;
const MAX_DAILY_RANGE_DAYS = 366;

export interface Totals {
  /** So'm. */
  amount: number;
  count: number;
}

export interface MonetizationSummary {
  currency: 'UZS';
  allTime: Totals;
  /** Since 00:00 today, Asia/Tashkent. */
  today: Totals;
  /** Rolling windows ending now. */
  last7Days: Totals;
  last30Days: Totals;
  /** Average paid donation (so'm, rounded); 0 when none. */
  averageAmount: number;
  /** Distinct logged-in donors who weren't anonymous. */
  donors: number;
  largest: StreamerDonationView | null;
}

/** What the streamer sees: the public view plus payment details. */
export interface StreamerDonationView extends DonationView {
  /** Donor's user id; null for guests and anonymous donations. */
  donorId: string | null;
  paymentSystem: string | null;
}

export interface DailyTotals extends Totals {
  /** YYYY-MM-DD, Asia/Tashkent. */
  date: string;
}

export interface StreamTotals extends Totals {
  streamId: string;
  /** Null when the VOD was deleted. */
  title: string | null;
  live: boolean;
  startedAt: Date | null;
  endedAt: Date | null;
  lastPaidAt: Date;
}

export interface TopDonor extends Totals {
  donorId: string;
  username: string | null;
  firstName: string;
  lastName: string;
  lastPaidAt: Date;
}

/** Read-only donation statistics for the streamer receiving them (paid only, unless filtered). */
@Injectable()
export class MonetizationService {
  constructor(
    @InjectRepository(Donation)
    private readonly donations: Repository<Donation>,
    private readonly liveStreamsService: LiveStreamsService,
  ) {}

  async summary(streamerId: string): Promise<MonetizationSummary> {
    const now = Date.now();
    const [row] = await this.donations.query<Record<string, string>[]>(
      `SELECT
         COALESCE(SUM(amount), 0) AS amount,
         COUNT(*) AS count,
         COALESCE(SUM(amount) FILTER (WHERE paid_at >= $2), 0) AS today_amount,
         COUNT(*) FILTER (WHERE paid_at >= $2) AS today_count,
         COALESCE(SUM(amount) FILTER (WHERE paid_at >= $3), 0) AS week_amount,
         COUNT(*) FILTER (WHERE paid_at >= $3) AS week_count,
         COALESCE(SUM(amount) FILTER (WHERE paid_at >= $4), 0) AS month_amount,
         COUNT(*) FILTER (WHERE paid_at >= $4) AS month_count,
         COUNT(DISTINCT donor_id) FILTER (WHERE NOT anonymous) AS donors
       FROM donations
       WHERE streamer_id = $1 AND status = 'paid'`,
      [
        streamerId,
        new Date(startOfDay(now)),
        new Date(now - 7 * DAY_MS),
        new Date(now - 30 * DAY_MS),
      ],
    );
    const largest = await this.donations.findOne({
      where: { streamerId, status: 'paid' },
      order: { amount: 'DESC', paidAt: 'DESC' },
    });
    const count = Number(row.count);
    return {
      currency: 'UZS',
      allTime: { amount: Number(row.amount), count },
      today: totals(row.today_amount, row.today_count),
      last7Days: totals(row.week_amount, row.week_count),
      last30Days: totals(row.month_amount, row.month_count),
      averageAmount: count ? Math.round(Number(row.amount) / count) : 0,
      donors: Number(row.donors),
      largest: largest ? toStreamerView(largest) : null,
    };
  }

  async list(
    streamerId: string,
    query: MonetizationDonationsQueryDto,
  ): Promise<Paginated<StreamerDonationView>> {
    const { status, streamId, page, limit } = query;
    const range = parseRange(query);
    const dateField = status === 'paid' ? 'paidAt' : 'createdAt';
    const now = new Date();

    const where: FindOptionsWhere<Donation> = { streamerId };
    if (streamId) where.streamId = streamId;
    if (status === 'expired') {
      where.status = 'pending';
      where.expiresAt = LessThan(now);
    } else if (status === 'pending') {
      where.status = 'pending';
      where.expiresAt = MoreThanOrEqual(now);
    } else if (status !== 'all') {
      where.status = status;
    }
    const bounds = [
      ...(range.from ? [MoreThanOrEqual(range.from)] : []),
      ...(range.to ? [LessThan(range.to)] : []),
    ];
    if (bounds.length) {
      where[dateField] = bounds.length === 1 ? bounds[0] : And(...bounds);
    }

    const [rows, total] = await this.donations.findAndCount({
      where,
      order: { [dateField]: 'DESC', id: 'DESC' },
      skip: query.offset,
      take: limit,
    });
    return { items: rows.map(toStreamerView), total, page, limit };
  }

  /** One entry per day in the range, zeros included. Default: the last 30 days. */
  async daily(
    streamerId: string,
    query: DailyQueryDto,
  ): Promise<DailyTotals[]> {
    const today = startOfDay(Date.now());
    const to = query.to ? parseDay(query.to, 'to') : today;
    const from = query.from ? parseDay(query.from, 'from') : to - 29 * DAY_MS;
    if (from > to) throw new BadRequestException('from must not be after to');
    const days = (to - from) / DAY_MS + 1;
    if (days > MAX_DAILY_RANGE_DAYS) {
      throw new BadRequestException(
        `The range can't be longer than ${MAX_DAILY_RANGE_DAYS} days`,
      );
    }

    const rows = await this.donations.query<Record<string, string>[]>(
      `SELECT to_char(paid_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS date,
              SUM(amount) AS amount, COUNT(*) AS count
       FROM donations
       WHERE streamer_id = $1 AND status = 'paid'
         AND paid_at >= $2 AND paid_at < $3
       GROUP BY 1`,
      [streamerId, new Date(from), new Date(to + DAY_MS)],
    );
    const byDate = new Map(rows.map((r) => [r.date, r]));
    return Array.from({ length: days }, (_, i) => {
      const date = formatDay(from + i * DAY_MS);
      const row = byDate.get(date);
      return { date, ...totals(row?.amount ?? 0, row?.count ?? 0) };
    });
  }

  /** Paid totals per stream (live or VOD), most recent stream first. */
  async byStream(
    streamerId: string,
    page: number,
    limit: number,
  ): Promise<Paginated<StreamTotals>> {
    const [{ total }] = await this.donations.query<{ total: string }[]>(
      `SELECT COUNT(DISTINCT stream_id) AS total FROM donations
       WHERE streamer_id = $1 AND status = 'paid'`,
      [streamerId],
    );
    const rows = await this.donations.query<Record<string, string | Date>[]>(
      `SELECT d.stream_id, SUM(d.amount) AS amount, COUNT(*) AS count,
              MAX(d.paid_at) AS last_paid_at,
              v.title, v.started_at, v.ended_at
       FROM donations d
       LEFT JOIN vods v ON v.id = d.stream_id
       WHERE d.streamer_id = $1 AND d.status = 'paid'
       GROUP BY d.stream_id, v.title, v.started_at, v.ended_at
       ORDER BY COALESCE(v.started_at, MIN(d.paid_at)) DESC, d.stream_id
       LIMIT $2 OFFSET $3`,
      [streamerId, limit, (page - 1) * limit],
    );
    const live = await this.liveStreamsService.findByUser(streamerId);

    const items = rows.map((r): StreamTotals => {
      const isLive = live?.id === r.stream_id;
      return {
        streamId: r.stream_id as string,
        title: isLive ? live.title : ((r.title as string | null) ?? null),
        live: isLive,
        startedAt: isLive
          ? new Date(live.startedAt)
          : ((r.started_at as Date | null) ?? null),
        endedAt: isLive ? null : ((r.ended_at as Date | null) ?? null),
        ...totals(r.amount as string, r.count as string),
        lastPaidAt: r.last_paid_at as Date,
      };
    });
    return { items, total: Number(total), page, limit };
  }

  /** Logged-in, non-anonymous donors ranked by amount. */
  async topDonors(
    streamerId: string,
    query: TopDonorsQueryDto,
  ): Promise<TopDonor[]> {
    const range = parseRange(query);
    const rows = await this.donations.query<Record<string, string | Date>[]>(
      `SELECT d.donor_id, u.username, u.first_name, u.last_name,
              SUM(d.amount) AS amount, COUNT(*) AS count,
              MAX(d.paid_at) AS last_paid_at
       FROM donations d
       JOIN users u ON u.id = d.donor_id
       WHERE d.streamer_id = $1 AND d.status = 'paid' AND NOT d.anonymous
         AND ($2::timestamptz IS NULL OR d.paid_at >= $2)
         AND ($3::timestamptz IS NULL OR d.paid_at < $3)
       GROUP BY d.donor_id, u.username, u.first_name, u.last_name
       ORDER BY SUM(d.amount) DESC, MAX(d.paid_at) DESC
       LIMIT $4`,
      [streamerId, range.from ?? null, range.to ?? null, query.limit],
    );
    return rows.map((r) => ({
      donorId: r.donor_id as string,
      username: (r.username as string | null) ?? null,
      firstName: r.first_name as string,
      lastName: r.last_name as string,
      ...totals(r.amount as string, r.count as string),
      lastPaidAt: r.last_paid_at as Date,
    }));
  }
}

function toStreamerView(d: Donation): StreamerDonationView {
  return {
    ...toView(d),
    donorId: d.anonymous ? null : d.donorId,
    paymentSystem: d.paymentSystem,
  };
}

/** Postgres returns SUM/COUNT as strings (bigint). */
function totals(amount: string | number, count: string | number): Totals {
  return { amount: Number(amount), count: Number(count) };
}

function parseRange({ from, to }: TimeRangeQueryDto) {
  const range = {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  };
  if (range.from && range.to && range.from >= range.to) {
    throw new BadRequestException('from must be before to');
  }
  return range;
}

/** UTC ms of 00:00 Asia/Tashkent on the day containing `ms`. */
function startOfDay(ms: number): number {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
}

/** "YYYY-MM-DD" (Tashkent) -> UTC ms of its 00:00. */
function parseDay(value: string, field: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || formatDay(ms - TZ_OFFSET_MS) !== value) {
    throw new BadRequestException(`${field} is not a valid date`);
  }
  return ms - TZ_OFFSET_MS;
}

function formatDay(utcMsOfTashkentMidnight: number): string {
  return new Date(utcMsOfTashkentMidnight + TZ_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}
