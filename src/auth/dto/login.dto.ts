import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  /** Email or username. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  login: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}
