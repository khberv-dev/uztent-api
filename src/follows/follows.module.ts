import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module.js';
import { Follow } from './entities/follow.entity.js';
import { FollowsController } from './follows.controller.js';
import { FollowsService } from './follows.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Follow]), UsersModule],
  controllers: [FollowsController],
  providers: [FollowsService],
})
export class FollowsModule {}
