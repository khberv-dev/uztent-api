import { Matches } from 'class-validator';

export class BindCardDto {
  /** Card holder's phone (SMS informing), 998XXXXXXXXX. Required for Humo. */
  @Matches(/^998\d{9}$/, {
    message: 'phone must be in the format 998XXXXXXXXX',
  })
  phone: string;
}
