import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import { CardsService } from './cards.service.js';
import { BindCardDto } from './dto/bind-card.dto.js';

/** The caller's saved cards (Multicard card binding). */
@Controller('payments/cards')
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.cardsService.list(user.id);
  }

  /** Starts binding: returns Multicard's card form URL. */
  @Post()
  bind(@CurrentUser() user: AuthUser, @Body() dto: BindCardDto) {
    return this.cardsService.startBinding(user.id, dto.phone);
  }

  @Get('bind/:bindId')
  checkBinding(
    @CurrentUser() user: AuthUser,
    @Param('bindId', ParseUUIDPipe) bindId: string,
  ) {
    return this.cardsService.checkBinding(user.id, bindId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.cardsService.remove(user.id, id);
  }
}

/** Multicard: a card was bound (`callback_url` of the binding session). */
@Public()
@Controller('webhooks/multicard/cards')
export class MulticardCardWebhookController {
  constructor(private readonly cardsService: CardsService) {}

  /** Always 200 (Multicard retries anything else 5 times). */
  @Post()
  @HttpCode(HttpStatus.OK)
  async callback(@Body() body: Record<string, unknown>) {
    try {
      await this.cardsService.handleCallback(body.payer_id);
    } catch {
      /* the client's poll will finish the binding */
    }
    return { success: true };
  }
}
