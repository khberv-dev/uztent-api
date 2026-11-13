import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
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

  /**
   * Pay with one of your saved cards (needs a token) instead of the payment
   * page: charged right away, or after an SMS code if Multicard asks for one.
   */
  @IsOptional()
  @IsUUID()
  cardId?: string;

  /** Language of the Multicard payment page. */
  @IsOptional()
  @IsIn(['ru', 'uz', 'en'])
  lang?: 'ru' | 'uz' | 'en';
}

export class ConfirmDonationDto {
  /** SMS code sent by Multicard to the card holder. */
  @Matches(/^\d{4,8}$/, { message: 'otp must be 4 to 8 digits' })
  otp: string;
}
