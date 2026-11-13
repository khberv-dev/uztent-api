import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy.js';

/**
 * Single source of truth for the PostgreSQL connection.
 * Schema is managed by `synchronize` (no migrations).
 */
export function createDataSource(config: ConfigService): DataSource {
  return new DataSource({
    type: 'postgres',
    host: config.getOrThrow<string>('DB_HOST'),
    port: Number(config.getOrThrow('DB_PORT')),
    username: config.getOrThrow<string>('DB_USERNAME'),
    password: config.getOrThrow<string>('DB_PASSWORD'),
    database: config.getOrThrow<string>('DB_NAME'),
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: true,
  });
}
