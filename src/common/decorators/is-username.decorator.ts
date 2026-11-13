import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';

/** Trims, lowercases and validates a username (3-30 of a-z, 0-9, _ and .). */
export const IsUsername = () =>
  applyDecorators(
    Transform(({ value }) =>
      typeof value === 'string' ? value.trim().toLowerCase() : value,
    ),
    Matches(/^[a-z0-9_.]{3,30}$/, {
      message:
        'username must be 3-30 characters: letters, digits, underscores or dots',
    }),
  );
