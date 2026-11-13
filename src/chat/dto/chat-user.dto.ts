import { IsUUID } from 'class-validator';

/** Body of ban and moderator endpoints. */
export class ChatUserDto {
  @IsUUID()
  userId: string;
}
