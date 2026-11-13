import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Send only the fields to change. */
export class UpdateStreamDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  title?: string;

  /** 0 turns slow mode off. Max 1 hour. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  chatSlowModeSeconds?: number;
}
