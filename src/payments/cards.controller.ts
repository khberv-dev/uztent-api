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
import type { AuthUser } from '../common/guards/jwt-auth.guard.js';
import { CardsService } from './cards.service.js';
import { BindCardDto, ConfirmCardDto } from './dto/bind-card.dto.js';

/** The caller's saved cards (Multicard card binding via API). */
@Controller('payments/cards')
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.cardsService.list(user.id);
  }

  /** Step 1: card data → Multicard texts a code to the card's phone. */
  @Post()
  bind(@CurrentUser() user: AuthUser, @Body() dto: BindCardDto) {
    return this.cardsService.startBinding(user.id, dto);
  }

  /** Step 2: the SMS code → the card is saved. */
  @Post('bind/:bindId/confirm')
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('bindId', ParseUUIDPipe) bindId: string,
    @Body() dto: ConfirmCardDto,
  ) {
    return this.cardsService.confirmBinding(user.id, bindId, dto.otp);
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
