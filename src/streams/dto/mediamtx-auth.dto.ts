import { IsOptional, IsString } from 'class-validator';

/**
 * MediaMTX HTTP auth request (`authMethod: http`). Sent before every
 * publish/read; any 2xx response allows the action. Unknown fields are dropped.
 */
export class MediamtxAuthDto {
  /** publish | read | playback | api | metrics | pprof */
  @IsString()
  action: string;

  /** e.g. `live/<streamId>` */
  @IsOptional()
  @IsString()
  path?: string;

  /** URL query without `?`, e.g. `key=sk_...` */
  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  user?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsString()
  protocol?: string;

  @IsOptional()
  @IsString()
  ip?: string;
}
