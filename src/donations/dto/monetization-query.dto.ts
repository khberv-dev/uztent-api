import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export const DONATION_STATUS_FILTERS = [
  'paid',
  'pending',
  'failed',
  'expired',
  'all',
] as const;
export type DonationStatusFilter = (typeof DONATION_STATUS_FILTERS)[number];

/** `from` inclusive, `to` exclusive, ISO 8601 instants. */
export class TimeRangeQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export class MonetizationDonationsQueryDto extends PaginationQueryDto {
  /** Default `paid`. Ranges filter on `paidAt` for paid, `createdAt` otherwise. */
  @IsOptional()
  @IsIn(DONATION_STATUS_FILTERS)
  status: DonationStatusFilter = 'paid';

  @IsOptional()
  @IsUUID()
  streamId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

/** Calendar days in Asia/Tashkent, both inclusive. */
export class DailyQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}

export class TopDonorsQueryDto extends TimeRangeQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;
}
