import { IsJWT } from 'class-validator';

export class GoogleLoginDto {
  /** ID token returned to the client by Google Sign-In. */
  @IsJWT()
  idToken: string;
}
