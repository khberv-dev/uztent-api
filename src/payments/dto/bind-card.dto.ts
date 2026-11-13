import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';

const digitsOnly = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/[\s-]/g, '') : value;

/**
 * Card data for Multicard's API binding. Passed through to Multicard and
 * never stored or logged.
 */
export class BindCardDto {
  /** Uzcard / Humo number; spaces and dashes are ignored. */
  @Transform(digitsOnly)
  @Matches(/^\d{16}$/, { message: 'pan must be a 16-digit card number' })
  pan: string;

  /** As printed on the card: MM/YY. */
  @Matches(/^(0[1-9]|1[0-2])\/\d{2}$/, { message: 'expiry must be MM/YY' })
  expiry: string;

  /** The card's SMS-informing phone, 998XXXXXXXXX. The code is sent there. */
  @Transform(digitsOnly)
  @Matches(/^998\d{9}$/, {
    message: 'phone must be in the format 998XXXXXXXXX',
  })
  phone: string;
}

export class ConfirmCardDto {
  /** SMS code sent by Multicard. */
  @Matches(/^\d{4,8}$/, { message: 'otp must be 4 to 8 digits' })
  otp: string;
}
