import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module.js';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const logger = new Logger('App');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const port = config.getOrThrow('PORT');
  const version = config.getOrThrow<string>('API_PREFIX');

  app.enableShutdownHooks();
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix(version);
  // Browser clients. Auth uses the Authorization header, not cookies.
  app.enableCors({
    origin: config
      .getOrThrow<string>('CORS_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  });

  await app.listen(port);

  logger.log(`Listening on :${port}`);
}
await bootstrap();
