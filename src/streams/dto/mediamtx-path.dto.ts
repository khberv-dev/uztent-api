import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Sent by the runOnOnline / runOnOffline commands: `-d path=$MTX_PATH`. */
export class MediamtxPathDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  path: string;
}
