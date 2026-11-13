import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import {
  DailyQueryDto,
  MonetizationDonationsQueryDto,
  TopDonorsQueryDto,
} from './dto/monetization-query.dto.js';
import { MonetizationService } from './monetization.service.js';

/** The caller's own earnings: donations they received as a streamer. */
@Controller('monetization')
export class MonetizationController {
  constructor(private readonly monetizationService: MonetizationService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.monetizationService.summary(user.id);
  }

  @Get('donations')
  donations(
    @CurrentUser() user: AuthUser,
    @Query() query: MonetizationDonationsQueryDto,
  ) {
    return this.monetizationService.list(user.id, query);
  }

  @Get('daily')
  daily(@CurrentUser() user: AuthUser, @Query() query: DailyQueryDto) {
    return this.monetizationService.daily(user.id, query);
  }

  @Get('streams')
  streams(@CurrentUser() user: AuthUser, @Query() query: PaginationQueryDto) {
    return this.monetizationService.byStream(user.id, query.page, query.limit);
  }

  @Get('top-donors')
  topDonors(@CurrentUser() user: AuthUser, @Query() query: TopDonorsQueryDto) {
    return this.monetizationService.topDonors(user.id, query);
  }
}
