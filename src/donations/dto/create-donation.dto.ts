import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateDonationDto {
  /** In so'm; DONATION_MIN_SOM..DONATION_MAX_SOM is checked by the service. */
  @IsInt()
  @IsPositive()
  amount: number;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(200)
  message?: string;

  /** Logged-in donors can hide their name. Guests are always anonymous. */
  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;

  /** Language of the Multicard payment page. */
  @IsOptional()
  @IsIn(['ru', 'uz', 'en'])
  lang?: 'ru' | 'uz' | 'en';
}
