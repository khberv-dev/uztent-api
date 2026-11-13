import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SetPasswordDto {
  /** Required only when the user already has a password. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  currentPassword?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}
