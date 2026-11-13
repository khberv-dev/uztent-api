import { IsUsername } from '../../common/decorators/is-username.decorator.js';

export class CheckUsernameDto {
  @IsUsername()
  username: string;
}
