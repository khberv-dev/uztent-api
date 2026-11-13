import { ValidationPipe } from '@nestjs/common';

/** Global DTO validation (registered as APP_PIPE in AppModule). */
export const validationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
