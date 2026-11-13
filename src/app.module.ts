import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';
import { AuthModule } from './auth/auth.module.js';
import { ChatModule } from './chat/chat.module.js';
import { DonationsModule } from './donations/donations.module.js';
import { EventsModule } from './events/events.module.js';
import { FollowsModule } from './follows/follows.module.js';
import { validationPipe } from './common/pipes/validation.pipe.js';
import { createDataSource } from './shared/config/database.config.js';
import { RedisModule } from './shared/redis/redis.module.js';
import { StreamsModule } from './streams/streams.module.js';
import { VodsModule } from './vods/vods.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...createDataSource(config).options,
        autoLoadEntities: true,
      }),
    }),
    // Any file in public/ (HTML, images, videos, …) at /public/<path>,
    // outside API_PREFIX; `.html` is optional in URLs. serveRoot keeps the
    // module's catch-all route under /public, away from the API.
    ServeStaticModule.forRoot({
      rootPath: join(import.meta.dirname, '..', 'public'),
      serveRoot: '/public',
      serveStaticOptions: { extensions: ['html'], index: false },
    }),
    RedisModule,
    EventsModule,
    UsersModule,
    AuthModule,
    VodsModule,
    StreamsModule,
    ChatModule,
    DonationsModule,
    FollowsModule,
  ],
  providers: [
    { provide: APP_PIPE, useValue: validationPipe },
    // Applies @Exclude/@Expose on entities (hides password, googleId).
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
  ],
})
export class AppModule {}
