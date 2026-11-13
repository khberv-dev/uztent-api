import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { REDIS } from '../shared/redis/redis.module.js';
import { PaymentCard } from './entities/payment-card.entity.js';
import {
  type MulticardCard,
  MulticardRejection,
  MulticardService,
} from './multicard.service.js';

export const MAX_CARDS_PER_USER = 10;
/** How long the SMS code can be entered. */
const BIND_TTL_SECONDS = 10 * 60;
const MAX_OTP_ATTEMPTS = 5;
/** Each binding sends an SMS: at most this many per user per 10 minutes. */
const BINDS_PER_WINDOW = 5;
const BIND_WINDOW_SECONDS = 10 * 60;

/**
 * Redis: `card:bind:<bindId>` hash: userId, cardToken (Multicard's draft
 * token), cardPan, ps, attempts. The card number itself is never stored.
 */
const bindKey = (id: string) => `card:bind:${id}`;

export interface CardBindingStart {
  /** Pass to POST /payments/cards/bind/:bindId/confirm with the SMS code. */
  bindId: string;
  cardPan: string;
  ps: string | null;
  /** The code must be entered before this. */
  expiresAt: Date;
}

@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);

  constructor(
    @InjectRepository(PaymentCard)
    private readonly cards: Repository<PaymentCard>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly multicard: MulticardService,
  ) {}

  list(userId: string): Promise<PaymentCard[]> {
    return this.cards.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  /** The user's card, with its token (for charging). 404 if not theirs. */
  async getOwned(userId: string, id: string): Promise<PaymentCard> {
    const card = await this.cards.findOneBy({ id, userId });
    if (!card) throw new NotFoundException('Card not found');
    return card;
  }

  /**
   * Step 1: sends the card to Multicard, which texts a code to `phone`.
   * `expiry` is MM/YY (Multicard wants YYMM).
   */
  async startBinding(
    userId: string,
    card: { pan: string; expiry: string; phone: string },
  ): Promise<CardBindingStart> {
    const [month, year] = card.expiry.split('/');
    if (isPast(Number(year), Number(month))) {
      throw new BadRequestException('The card has expired');
    }
    if ((await this.cards.countBy({ userId })) >= MAX_CARDS_PER_USER) {
      throw new BadRequestException(
        `You can link at most ${MAX_CARDS_PER_USER} cards`,
      );
    }
    await this.rateLimit(userId);

    let draft: MulticardCard;
    try {
      draft = await this.multicard.addCard({
        pan: card.pan,
        expiry: `${year}${month}`,
        phone: card.phone,
      });
    } catch (error) {
      throw cardRejected(error);
    }

    const bindId = randomUUID();
    await this.redis
      .multi()
      .hset(bindKey(bindId), {
        userId,
        cardToken: draft.cardToken,
        cardPan: draft.cardPan,
        ps: draft.ps ?? '',
        attempts: '0',
      })
      .expire(bindKey(bindId), BIND_TTL_SECONDS)
      .exec();
    return {
      bindId,
      cardPan: draft.cardPan,
      ps: draft.ps,
      expiresAt: new Date(Date.now() + BIND_TTL_SECONDS * 1000),
    };
  }

  /** Step 2: the SMS code. Saves and returns the card. */
  async confirmBinding(
    userId: string,
    bindId: string,
    otp: string,
  ): Promise<PaymentCard> {
    const session = await this.redis.hgetall(bindKey(bindId));
    if (session.userId !== userId) {
      throw new NotFoundException('Card binding not found or expired');
    }
    const attempts = await this.redis.hincrby(bindKey(bindId), 'attempts', 1);
    if (attempts > MAX_OTP_ATTEMPTS) {
      await this.redis.del(bindKey(bindId));
      throw new HttpException(
        'Too many wrong codes. Add the card again',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let bound: MulticardCard;
    try {
      bound = await this.multicard.confirmCard(session.cardToken, otp);
    } catch (error) {
      if (
        error instanceof MulticardRejection &&
        error.code === 'ERROR_WRONG_OTP'
      ) {
        throw new BadRequestException('Wrong or expired confirmation code');
      }
      throw cardRejected(error);
    }
    if (bound.status !== 'active') {
      throw new HttpException(
        {
          statusCode: 400,
          message: 'The card was not activated',
          reason: bound.status,
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.redis.del(bindKey(bindId));

    // The same card added twice may come back with the same token.
    await this.cards
      .createQueryBuilder()
      .insert()
      .values({
        userId,
        cardToken: bound.cardToken,
        cardPan: bound.cardPan || session.cardPan,
        ps: bound.ps ?? (session.ps || null),
      })
      .orIgnore()
      .execute();
    const saved = await this.cards.findOneBy({ cardToken: bound.cardToken });
    if (!saved || saved.userId !== userId) {
      throw new ConflictException('This card is linked to another account');
    }
    return saved;
  }

  async remove(userId: string, id: string): Promise<void> {
    const card = await this.getOwned(userId, id);
    try {
      await this.multicard.deleteCard(card.cardToken);
    } catch (error) {
      // Already gone at Multicard: still remove it here.
      if (!(error instanceof MulticardRejection)) throw error;
      this.logger.warn(`Card ${card.id} delete: ${error.code}`);
    }
    await this.cards.delete(card.id);
  }

  private async rateLimit(userId: string) {
    const key = `card:bind:rate:${userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, BIND_WINDOW_SECONDS);
    if (count > BINDS_PER_WINDOW) {
      throw new HttpException(
        'Too many attempts to add a card, try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/** Multicard refused the card (wrong number, no SMS informing, …): 400 with its code. */
function cardRejected(error: unknown): unknown {
  if (!(error instanceof MulticardRejection)) return error;
  if (error.httpStatus === 429) {
    return new HttpException(
      'A code was sent recently, wait a minute and try again',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  return new HttpException(
    {
      statusCode: HttpStatus.BAD_REQUEST,
      message: 'The card was rejected',
      error: 'Bad Request',
      reason: error.code,
    },
    HttpStatus.BAD_REQUEST,
  );
}

/** True if the card's expiry month (YY, MM) is over (cards work through it). */
function isPast(yy: number, mm: number): boolean {
  const now = new Date(Date.now() + 5 * 3600_000); // Tashkent
  const year = now.getUTCFullYear() % 100;
  const month = now.getUTCMonth() + 1;
  return yy < year || (yy === year && mm < month);
}
