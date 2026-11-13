# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NestJS 12 API (Express) on TypeORM 1.x + PostgreSQL and Redis (ioredis), with JWT auth, Google sign-in, live streams and VODs. No tests exist yet, and the README is the stock Nest starter text.

Everything in `public/` is served at `/public/<path>` (`ServeStaticModule` in `AppModule`; `.html` optional), including `public/privacy_policy.html` and `public/terms_use.html`. `serveRoot: '/public'` is required: without it, the module's catch-all `GET` route would shadow the API's routes. Everything in `public/` is publicly downloadable. The policies describe what the app actually collects, so update them when data handling changes (new fields, third parties, retention).

`docs.md` is the single source of documentation: architecture, how it works, use cases, REST and WebSocket APIs with request/response samples, MediaMTX integration, and a complete React client (its code was type-checked and its API layer run against the API). Update it whenever endpoints, events, DTO rules or error messages change.

## Commands

```bash
npm run start:dev        # watch mode (needs a reachable Postgres and a complete .env)
npm run build            # nest build -> dist/
npm run start:prod       # node dist/main
npm run lint             # oxlint --type-aware on src/ and test/ (not ESLint)
npm run format           # prettier (single quotes, trailing commas)

npm test                 # vitest, unit tests: **/*.spec.ts
npm run test:e2e         # vitest, e2e tests: **/*.e2e-spec.ts
npx vitest run path/to/file.spec.ts        # single test file
npx vitest run -t "test name"              # single test by name
```

Vitest runs with `globals: true`, and `vite-tsconfig-paths` resolves tsconfig path aliases.

## Environment

`.env` is loaded by a global `ConfigModule`, and every variable is read with `getOrThrow`, so the app won't start if any is missing. `.env.example` lists them all:
- `CORS_ORIGINS`: comma-separated browser origins passed to `app.enableCors` in `main.ts`
- `PORT` and `API_PREFIX`: `API_PREFIX` is passed to `app.setGlobalPrefix`, so with `v1` every route lives under `/v1/...`. Nest's built-in versioning is not used.
- `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`
- `JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL` (seconds), `REFRESH_TOKEN_TTL_DAYS`
- `GOOGLE_CLIENT_IDS`: comma-separated Google OAuth client IDs (web, iOS, Android); must not be empty
- `REDIS_URL`; `HLS_BASE_URL`, the MediaMTX HLS root (original = `/live/<streamId>/index.m3u8`, renditions = `/watch/<streamId>/<quality>/index.m3u8`); `STREAM_RENDITIONS` (currently `1080`)
- `STREAM_PUBLISH_URL`: the encoder's ingest server, saved on a user's `Stream` row when their key is generated
- `MEDIAMTX_API_URL` (MediaMTX control API, needs `api: yes`) and `VIEWERS_POLL_SECONDS`
- `MULTICARD_*` and `DONATION_*`: payment gateway credentials, callback and return URLs, and donation limits (see docs.md "Configuration")
- `WEBHOOK_ALLOWED_IPS`: comma-separated IPs or CIDR masks allowed to call `/webhooks/*`; an invalid entry fails at startup

## Architecture

- **Layout**: feature modules (`src/users`, `src/auth`, `src/streams`, `src/vods`) each hold `entities/` and `dto/`. Cross-cutting Nest pieces live in `src/common/{decorators,dto,guards,pipes,utils}`, configuration factories in `src/shared/config`, and the global Redis client in `src/shared/redis` (inject with `@Inject(REDIS) redis: Redis`).
- **Pagination**: list endpoints take `PaginationQueryDto` (`page`, `limit` ≤ 100, `offset` getter) and return `Paginated<T>` (`{ items, total, page, limit }`).
- **Global wiring**:
  - `AppModule` registers the `ValidationPipe` as `APP_PIPE` (`whitelist`, `forbidNonWhitelisted`, `transform`) and `ClassSerializerInterceptor` as `APP_INTERCEPTOR`.
  - `AuthModule` registers `JwtAuthGuard` as `APP_GUARD`, so every route requires `Authorization: Bearer <access token>` unless it's marked `@Public()`.
  - `@CurrentUser()` returns `{ id }` from the JWT with no DB lookup.
- **Database**:
  - `createDataSource(config)` in `src/shared/config/database.config.ts` builds a `DataSource`, and its `.options` are passed to `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`. Register entities with `TypeOrmModule.forFeature` in their own module.
  - **No migrations**: the schema comes from `synchronize: true`.
  - A hand-written `SnakeNamingStrategy` maps properties to snake_case columns, so don't pass column names to `@Column`. It's custom because `typeorm-naming-strategies` doesn't support TypeORM 1.x.
  - Table names are given explicitly and in the plural (`@Entity('users')`).
- **Streams and VODs**: the word "stream" means two things here.
  - `Stream` entity (`streams` table, `StreamsService`): a user's **static** settings, one-to-one with `User`, holding `title`, `streamKey` and `publishUrl`. `POST /streams/me/key` upserts it on `userId`, which replaces the key and keeps `id`. The `id` is public: it's the MediaMTX path (`live/<id>`) and therefore the HLS URL. The encoder sends the secret as `?key=` (the `encoderStreamKey` getter).
  - `LiveStream` (`LiveStreamsService`): a **live session**, kept only in Redis, described below. There's no user endpoint to start or end one. MediaMTX (v1.21) calls `MediamtxWebhooksController`:
    - `POST /webhooks/mediamtx/auth` (`authHTTPAddress`, MediaMTX's JSON) allows `read`/`playback`, and allows `publish` only when `path`=`live/<streamId>` and `query` `key=` matches. The one exception is publishes to `watch/…` from a loopback `ip`: the ffmpeg in the user's mediamtx.yml republishes the source there as the `1080` rendition (stream copy).
    - `/online` and `/offline` (`runOnOnline`/`runOnOffline` curl, `-d path=$MTX_PATH`) find the stream by path, not by key, so replacing a key mid-broadcast is safe.
    - The routes are `@Public()` and guarded by `IpAllowlistGuard` (`src/common/guards`, `WEBHOOK_ALLOWED_IPS`, using `net.BlockList`) instead.
    - Bodies are typed `Record<string, unknown>` so the global `forbidNonWhitelisted` pipe skips them. Local `ValidationPipe({ whitelist, expectedType })` instances validate them and drop MediaMTX's extra fields.
    - The reference `mediamtx.yml` lives in `docs.md` ("MediaMTX setup"). The official image is FROM scratch (no curl or ffmpeg), so the hooks need a custom image or a native install.
    - `GET /streams/:idOrUsername` is `@Public()` (channel pages). A UUID means a live stream id; anything else is a username, and usernames can't contain `-`. By username it returns 404 `User not found` vs `User is not live`, and the React client tells them apart by the message.
    - `start()` is idempotent per user (a reconnect returns the existing session), and `end()` returns `null` when the user isn't live.
  - Live-stream playback URLs (`url` + `renditions`) aren't stored. `LiveStreamsService.toLiveStream` builds them on every read from the stored `streamId`, so `HLS_BASE_URL`/`STREAM_RENDITIONS` changes apply to sessions that are already live.
  - A live stream exists only in Redis. The keys are `stream:<id>` (hash, including an internal `peakViewers`), `stream:user:<userId>` (the user's single live stream, claimed with `SET NX`) and `streams:live` (a sorted set scored by start time).
  - Ending a live session (`LiveStreamsService.end`) first inserts a `Vod` with the **same id** as the stream, then deletes the Redis keys, so a failed insert leaves the stream live and the webhook can be retried. `VodsService.create` is idempotent on that id.
  - `ViewerCounterService` polls MediaMTX `GET /v3/paths/list` (`MEDIAMTX_API_URL`) every `VIEWERS_POLL_SECONDS`:
    - It counts readers on `live/<streamId>` and `watch/<streamId>/*`, excluding the transcoder's `rtspSession` reader on `live/`.
    - A Lua script sets `viewers` and the running max `peakViewers`, but only if the hash still exists, so a poll racing with stream end can't recreate it.
    - MediaMTX drops HLS sessions about 40 s after the last request, so counts lag on the way down.
  - **WebSocket events** (`src/events`):
    - `EventsGateway` serves `ws://host:PORT/ws` with `@nestjs/platform-ws` (`WsAdapter` in `main.ts`). It isn't under `API_PREFIX`, has no auth, and is server→client only, with a 30 s ping to drop dead connections.
    - `EventsService.publish()` sends `stream.started` / `stream.ended` over Redis pub/sub (channel `events`, on a duplicated subscriber connection), so every instance relays them.
    - `broadcastLocal()` is used for `stream.viewers`, which each instance's `ViewerCounterService` sends after every poll.
    - `GET /streams` is public to match.
  - **Chat** (`src/chat`):
    - `ChatMessage` rows are keyed by the live stream id (= VOD id), with no FK to `vods`. `VodsService.delete` removes them through its own `ChatMessage` repository, which avoids a module cycle.
    - `ChatBan` and `ChatModerator` are per channel (`channelUserId`, `userId`).
    - Sending is REST (`POST /streams/:id/chat`, live only), with two Redis `SET NX` limits:
      - a global per-user interval, `CHAT_MESSAGE_INTERVAL_MS`, that applies to everyone;
      - per-channel slow mode (`Stream.chatSlowModeSeconds`, copied into the live hash), for viewers only.
    - Delivery is the `chat.message` / `chat.deleted` / `chat.settings` events through `EventsService.publish`. `LiveStreamsService.updateLive` publishes `chat.settings`.
    - Roles are per channel: the streamer (owner), `ChatModerator` rows, or viewer. `ChatService.roleIn` / `assertCanModerate` enforce them.
    - Moderators can delete messages and ban or unban viewers via `/streams/:id/chat/bans`, but can't ban moderators or the streamer. When the streamer bans a moderator, the role is removed; promoting a banned user unbans them.
    - `senderRole` is stored on each message as a badge snapshot.
    - `EventsGateway` handles `chat.join` / `chat.leave` (`@SubscribeMessage`, at most 10 per connection) and sends `chat.*` only to clients that joined.
    - `JwtAuthGuard` skips non-HTTP contexts, because as an `APP_GUARD` it also runs on WebSocket messages.
  - **Donations** (`src/donations`, `src/payments/multicard.service.ts`) use Multicard's hosted-invoice strategy:
    - `POST /streams/:idOrUsername/donations` is `@Public()`. A valid token still identifies the donor: `JwtAuthGuard` verifies tokens on public routes when present, and `@OptionalUser()` reads them.
    - It needs a live stream, saves a `Donation` (status `pending`; its id is Multicard's `invoice_id`), creates the invoice (amount in **tiyin**, no `ofd` fiscal data), and returns `checkoutUrl` (`app.rhmt.uz`).
    - `MulticardService` caches the `/auth` token until `expiry` (GMT+5) and retries once on 401.
    - `POST /webhooks/multicard` always returns 200 with `{ success }`. Anything else makes Multicard refund. It verifies `md5(store_id+invoice_id+amount+secret)`, the store and the amount, then marks the donation paid with a conditional update (`status != 'paid'`). Only that update publishes `donation.received`, to the stream room, the same routing as `chat.*`.
    - Tests use a local fake Multicard; it hasn't been verified against the real sandbox yet.
    - **Saved cards** (`src/payments/cards.*`, `PaymentCard` entity): Multicard's card binding **via API** (PCI DSS partners only). `POST /payments/cards` passes `pan`/`expiry`/`phone` straight to `POST /payment/card` (never stored or logged; `MulticardService` redacts card tokens in log paths); the draft token waits in Redis `card:bind:<bindId>` (10 min, 5 OTP attempts) until `POST /payments/cards/bind/:bindId/confirm` → `PUT /payment/card/:token`. `cardToken` is `@Exclude`d.
    - A donation with `cardId` (`paymentMethod: 'card'`) charges the token: `POST /payment`, then `PUT /payment/:uuid` right away when `otp_hash` is null, otherwise `awaitingOtp` until `POST /donations/:id/confirm`. `MulticardRejection` carries Multicard's error code; declines become 402 `{ reason }`. All paths (callback, confirm, `GET /donations/:id` sync) go through `DonationsService.markPaid`, the single conditional update that publishes `donation.received`.
    - `MonetizationController` (`/monetization/*`, Bearer) is the streamer's read-only view of donations they received: summary, filtered list, daily, per stream, top donors. Aggregates are raw SQL in `MonetizationService` (Postgres returns `SUM`/`COUNT` as strings). Days are Asia/Tashkent (fixed UTC+5). Anonymous donations never expose `donorId`, not even to the streamer.
  - **Follows** (`src/follows`): `Follow` rows (composite PK `followerId`+`followingId`) under `/users/:userId/follow|followers|following`. The followed user's count is denormalized on `Stream.followersCount`: `FollowsService` inserts with `ON CONFLICT DO NOTHING` / deletes with `RETURNING` and changes the counter in the same transaction only when a row actually changed. A user without a `streams` row has their count computed from `follows`; `StreamsService.generateKey` recomputes it onto the row.
  - `previewUri`/`videoUri` stay null until a media-pipeline integration exists.
- **Auth flows** (`src/auth`):
  - **Google**: `POST /auth/google` takes an ID token, verifies it with `google-auth-library`, and finds the user by `googleId`. Failing that it auto-links an existing user by verified email, otherwise it creates one. Google is the only way users are created; there is no password sign-up.
  - **Password**: `POST /auth/login` takes an email (if it contains `@`) or a username. `POST /auth/password` sets the first password or changes it (current password required). It revokes every refresh token for the user and returns a new pair.
  - Passwords are hashed with Node's built-in scrypt (`PasswordService`).
  - **Refresh token**: the opaque string `<refresh_tokens.id>.<secret>`, stored as sha256(secret), one row per session. `/auth/refresh` rotates it.

## Conventions and gotchas

- **ESM** (`"type": "module"`, `nodenext`): relative imports need a `.js` extension, e.g. `'./users.service.js'`.
- **Nullable columns**: union types such as `string | null` need an explicit `type` in `@Column`, because decorator metadata emits `Object` for them.
- **Responses**: return entity instances, not spread copies, so `@Exclude`/`@Expose` apply. `User.password` and `googleId` are excluded, and `hasPassword` is exposed.
- **Lowercase**: emails and usernames are stored lowercase, so normalize before lookups.
- **Unique conflicts**: a Postgres unique violation is detected with `isUniqueViolation()` and turned into a `409 ConflictException`.
- **Lint**: `typescript/no-floating-promises` is an error.
- **TypeScript**: `strict`, with `strictPropertyInitialization` off.
