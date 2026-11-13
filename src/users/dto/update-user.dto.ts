import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { IsUsername } from '../../common/decorators/is-username.decorator.js';

export class UpdateUserDto {
  // ValidateIf instead of IsOptional: IsOptional would let `null` through
  // to NOT NULL columns.
  @ValidateIf((o: UpdateUserDto) => o.firstName !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @ValidateIf((o: UpdateUserDto) => o.lastName !== undefined)
  @IsString()
  @MaxLength(100)
  lastName?: string;

  /** `null` clears the username. */
  @IsOptional()
  @IsUsername()
  username?: string | null;
}
