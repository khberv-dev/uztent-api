import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface CreateInvoiceParams {
  /** Our id, echoed back in the callback. */
  invoiceId: string;
  /** Tiyin (1 so'm = 100 tiyin). */
  amount: number;
  callbackUrl: string;
  returnUrl?: string;
  lang?: 'ru' | 'uz' | 'en';
  /** Seconds until Multicard cancels the unpaid invoice. */
  ttl?: number;
}

export interface MulticardInvoice {
  /** Multicard transaction id. */
  uuid: string;
  /** Payment page (app.rhmt.uz) to send the payer to. */
  checkoutUrl: string;
  shortLink: string | null;
  deeplink: string | null;
}

/** Body of Multicard's success callback (docs: "Callback (success)"). */
export interface MulticardCallback {
  store_id: number | string;
  amount: number | string;
  invoice_id: string;
  uuid: string;
  sign: string;
  billing_id?: string;
  payment_time?: string;
  phone?: string;
  card_pan?: string;
  ps?: string;
  receipt_url?: string;
}

/** A bound card (docs: "Привязка карт (API)"). */
export interface MulticardCard {
  /** draft = waiting for the SMS code; active = usable. */
  status: string;
  cardToken: string;
  /** Masked, e.g. 986027******1519. */
  cardPan: string;
  /** uzcard, humo, visa, mastercard, unionpay. */
  ps: string | null;
}

/** The parts of Multicard's PaymentModel we use. */
export interface MulticardPayment {
  uuid: string;
  /** draft, progress, billing, hold, success, error, revert. */
  status: string;
  /** Not null when the payment must be confirmed with an SMS code. */
  otpHash: string | null;
  ps: string | null;
  receiptUrl: string | null;
  /** "YYYY-mm-dd H:i:s", GMT+5. */
  paymentTime: string | null;
}

/** Multicard answered with `success: false` (e.g. a declined card). */
export class MulticardRejection extends BadGatewayException {
  constructor(
    readonly code: string,
    readonly details: string,
    /** Multicard's HTTP status (e.g. 429 when an SMS was just sent). */
    readonly httpStatus: number,
  ) {
    super('Payment provider rejected the request');
  }
}

interface MulticardResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; details: string };
}

/**
 * Multicard payment gateway (docs.multicard.uz). POST /auth → token, then:
 * - hosted invoice: POST /payment/invoice → checkout_url, signed callback;
 * - card binding (API, PCI DSS): POST /payment/card → SMS, PUT to confirm;
 * - token payment: POST /payment, then PUT /payment/:uuid (empty or OTP).
 */
@Injectable()
export class MulticardService {
  private readonly logger = new Logger(MulticardService.name);
  private readonly apiUrl: string;
  private readonly applicationId: string;
  private readonly secret: string;
  readonly storeId: string;

  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(config: ConfigService) {
    this.apiUrl = config
      .getOrThrow<string>('MULTICARD_API_URL')
      .replace(/\/+$/, '');
    this.applicationId = config.getOrThrow<string>('MULTICARD_APPLICATION_ID');
    this.secret = config.getOrThrow<string>('MULTICARD_SECRET');
    this.storeId = String(config.getOrThrow('MULTICARD_STORE_ID'));
  }

  async createInvoice(params: CreateInvoiceParams): Promise<MulticardInvoice> {
    const data = await this.request<{
      uuid: string;
      checkout_url: string;
      short_link?: string;
      deeplink?: string;
    }>('POST', '/payment/invoice', {
      store_id: this.storeId,
      amount: params.amount,
      invoice_id: params.invoiceId,
      callback_url: params.callbackUrl,
      return_url: params.returnUrl,
      lang: params.lang,
      ttl: params.ttl,
    });
    return {
      uuid: data.uuid,
      checkoutUrl: data.checkout_url,
      shortLink: data.short_link ?? null,
      deeplink: data.deeplink ?? null,
    };
  }

  /**
   * Card binding via API (PCI DSS partners only): sends the card data and
   * makes Multicard text a code to the card's phone. Returns a draft token.
   */
  async addCard(params: {
    pan: string;
    /** YYMM. */
    expiry: string;
    phone: string;
  }): Promise<MulticardCard> {
    return toCard(
      await this.request<RawCard>('POST', '/payment/card', {
        pan: params.pan,
        expiry: params.expiry,
        user_phone: params.phone,
      }),
    );
  }

  /** Confirms a draft card with the SMS code; `status` becomes `active`. */
  async confirmCard(cardToken: string, otp: string): Promise<MulticardCard> {
    return toCard(
      await this.request<RawCard>(
        'PUT',
        `/payment/card/${encodeURIComponent(cardToken)}`,
        { otp },
      ),
    );
  }

  /** Revokes a card token. */
  async deleteCard(cardToken: string): Promise<void> {
    await this.request(
      'DELETE',
      `/payment/card/${encodeURIComponent(cardToken)}`,
    );
  }

  /** Step 1 of a token payment: nothing is debited yet. */
  async createTokenPayment(params: {
    cardToken: string;
    /** Tiyin. */
    amount: number;
    invoiceId: string;
    callbackUrl: string;
    ip: string;
    userAgent: string;
  }): Promise<MulticardPayment> {
    return toPayment(
      await this.request<RawPayment>('POST', '/payment', {
        card: { token: params.cardToken },
        amount: params.amount,
        store_id: Number(this.storeId),
        invoice_id: params.invoiceId,
        callback_url: params.callbackUrl,
        device_details: { ip: params.ip, user_agent: params.userAgent },
      }),
    );
  }

  /**
   * Step 2: debits the card. Without `otp` (otp_hash was null) the body is
   * empty. ERROR_DEBIT_UNKNOWN / ERROR_CALLBACK_TIMEOUT mean "check status".
   */
  async confirmPayment(uuid: string, otp?: string): Promise<MulticardPayment> {
    return toPayment(
      await this.request<RawPayment>(
        'PUT',
        `/payment/${encodeURIComponent(uuid)}`,
        otp === undefined ? {} : { otp, debit_available: false },
      ),
    );
  }

  async getPayment(uuid: string): Promise<MulticardPayment> {
    return toPayment(
      await this.request<RawPayment>(
        'GET',
        `/payment/${encodeURIComponent(uuid)}`,
      ),
    );
  }

  /** Cancels an unpaid invoice. */
  async cancelInvoice(uuid: string): Promise<void> {
    await this.request('DELETE', `/payment/invoice/${uuid}`);
  }

  /**
   * Success callback signature: md5(store_id + invoice_id + amount + secret),
   * hex. Compared in constant time.
   */
  verifyCallback(body: MulticardCallback): boolean {
    if (typeof body.sign !== 'string') return false;
    const expected = createHash('md5')
      .update(`${body.store_id}${body.invoice_id}${body.amount}${this.secret}`)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(body.sign.toLowerCase());
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(15_000),
    };
    if (body !== undefined && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(this.apiUrl + path, init);
    } catch (error) {
      this.logger.error(`${method} ${redact(path)} failed: ${String(error)}`);
      throw new BadGatewayException('Payment provider is unavailable');
    }

    // Token revoked or expired early: get a new one and retry once.
    if (response.status === 401 && !retried) {
      this.token = null;
      return this.request<T>(method, path, body, true);
    }

    const json = (await response
      .json()
      .catch(() => null)) as MulticardResponse<T> | null;
    if (!response.ok || !json?.success) {
      const error = json?.error
        ? `${json.error.code}: ${json.error.details}`
        : `HTTP ${response.status}`;
      this.logger.error(`${method} ${redact(path)} rejected: ${error}`);
      if (json?.error) {
        throw new MulticardRejection(
          json.error.code,
          json.error.details,
          response.status,
        );
      }
      throw new BadGatewayException('Payment provider rejected the request');
    }
    return json.data as T;
  }

  /** Cached until shortly before `expiry`; concurrent callers share one request. */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.value;
    }
    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_id: this.applicationId,
          secret: this.secret,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      this.logger.error(`Auth failed: ${String(error)}`);
      throw new BadGatewayException('Payment provider is unavailable');
    }
    const json = (await response.json().catch(() => null)) as {
      token?: string;
      expiry?: string;
    } | null;
    if (!response.ok || !json?.token) {
      this.logger.error(`Auth rejected: HTTP ${response.status}`);
      throw new BadGatewayException('Payment provider rejected the request');
    }
    this.token = { value: json.token, expiresAt: parseExpiry(json.expiry) };
    return json.token;
  }
}

/** Card tokens charge cards: keep them out of logs. */
function redact(path: string): string {
  return path.replace(
    /^\/payment\/card\/(?!check\/)[^/]+/,
    '/payment/card/***',
  );
}

interface RawCard {
  status: string;
  card_token: string;
  card_pan: string;
  ps?: string | null;
}

function toCard(raw: RawCard): MulticardCard {
  return {
    status: raw.status,
    cardToken: raw.card_token,
    cardPan: raw.card_pan,
    ps: raw.ps ?? null,
  };
}

interface RawPayment {
  uuid: string;
  status: string;
  otp_hash?: string | null;
  ps?: string | null;
  receipt_url?: string | null;
  payment_time?: string | null;
}

function toPayment(raw: RawPayment): MulticardPayment {
  return {
    uuid: raw.uuid,
    status: raw.status,
    otpHash: raw.otp_hash ?? null,
    ps: raw.ps ?? null,
    receiptUrl: raw.receipt_url ?? null,
    paymentTime: raw.payment_time ?? null,
  };
}

/** "YYYY-MM-DD HH:MM:SS" in GMT+5 → epoch ms (fallback: 10 minutes). */
function parseExpiry(expiry: string | undefined): number {
  const match = expiry?.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  if (!match) return Date.now() + 10 * 60_000;
  const time = Date.parse(`${match[1]}T${match[2]}+05:00`);
  return Number.isNaN(time) ? Date.now() + 10 * 60_000 : time;
}
