import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { REDIS } from '../shared/redis/redis.module.js';
import { PaymentCard } from './entities/payment-card.entity.js';
import { MulticardRejection, MulticardService } from './multicard.service.js';

/** Multicard's binding session lives 15 minutes; keep ours a bit longer. */
const BIND_TTL_SECONDS = 20 * 60;
export const MAX_CARDS_PER_USER = 10;

/**
 * Redis:
 * - `card:bind:<bindId>`        hash: userId, sessionId, cardId (once bound)
 * - `card:bind:session:<sid>`   string: bindId (to resolve Multicard's callback)
 */
const bindKey = (id: string) => `card:bind:${id}`;
const sessionKey = (sid: string) => `card:bind:session:${sid}`;

export interface CardBindingStart {
  bindId: string;
  /** Multicard's card form: redirect the user or open it in a WebView. */
  formUrl: string;
  expiresAt: Date;
}

export interface CardBindingState {
  /** pending: the form isn't completed yet; active: the card is saved. */
  status: 'pending' | 'active' | 'deleted';
  card: PaymentCard | null;
}

@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);
  private readonly callbackUrl: string;
  private readonly returnUrl: string;

  constructor(
    @InjectRepository(PaymentCard)
    private readonly cards: Repository<PaymentCard>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly multicard: MulticardService,
    config: ConfigService,
  ) {
    this.callbackUrl = config.getOrThrow<string>('MULTICARD_CARD_CALLBACK_URL');
    this.returnUrl = config.getOrThrow<string>('CARD_BIND_RETURN_URL');
  }

  list(userId: string): Promise<PaymentCard[]> {
    return this.cards.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  /** The user's card, with its token (for charging). 404 if not theirs. */
  async getOwned(userId: string, id: string): Promise<PaymentCard> {
    const card = await this.cards.findOneBy({ id, userId });
    if (!card) throw new NotFoundException('Card not found');
    return card;
  }

  async startBinding(userId: string, phone: string): Promise<CardBindingStart> {
    if ((await this.cards.countBy({ userId })) >= MAX_CARDS_PER_USER) {
      throw new BadRequestException(
        `You can link at most ${MAX_CARDS_PER_USER} cards`,
      );
    }
    const bindId = randomUUID();
    const { sessionId, formUrl } = await this.multicard.createCardBinding({
      phone,
      redirectUrl: withQuery(this.returnUrl, { bindId, result: 'success' }),
      redirectDeclineUrl: withQuery(this.returnUrl, {
        bindId,
        result: 'declined',
      }),
      callbackUrl: this.callbackUrl,
    });
    await this.redis
      .multi()
      .hset(bindKey(bindId), { userId, sessionId })
      .expire(bindKey(bindId), BIND_TTL_SECONDS)
      .set(sessionKey(sessionId), bindId, 'EX', BIND_TTL_SECONDS)
      .exec();
    return {
      bindId,
      formUrl,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
  }

  /** Polled by the client after the form; also run by the callback. */
  async checkBinding(
    userId: string,
    bindId: string,
  ): Promise<CardBindingState> {
    const session = await this.redis.hgetall(bindKey(bindId));
    if (session.userId !== userId) {
      throw new NotFoundException('Card binding not found or expired');
    }
    return this.complete(bindId, session);
  }

  /**
   * Multicard's bind callback isn't signed, so its body is only used to find
   * the session; the card itself is fetched from Multicard's API.
   */
  async handleCallback(payerId: unknown): Promise<void> {
    if (typeof payerId !== 'string' || !payerId) return;
    const bindId = await this.redis.get(sessionKey(payerId));
    if (!bindId) return;
    const session = await this.redis.hgetall(bindKey(bindId));
    if (!session.userId) return;
    await this.complete(bindId, session);
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

  private async complete(
    bindId: string,
    session: Record<string, string>,
  ): Promise<CardBindingState> {
    if (session.cardId) {
      const card = await this.cards.findOneBy({ id: session.cardId });
      if (card) return { status: 'active', card };
    }
    const binding = await this.multicard.getCardBinding(session.sessionId);
    if (binding.status === 'deleted') return { status: 'deleted', card: null };
    if (binding.status !== 'active' || !binding.cardToken) {
      return { status: 'pending', card: null };
    }

    // The callback and the client's poll can race: the unique token decides.
    await this.cards
      .createQueryBuilder()
      .insert()
      .values({
        userId: session.userId,
        cardToken: binding.cardToken,
        cardPan: binding.cardPan ?? '',
        ps: binding.ps,
      })
      .orIgnore()
      .execute();
    const card = await this.cards.findOneBy({ cardToken: binding.cardToken });
    if (!card || card.userId !== session.userId) {
      throw new ConflictException('This card is linked to another account');
    }
    await this.redis.hset(bindKey(bindId), 'cardId', card.id);
    return { status: 'active', card };
  }
}

function withQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}
