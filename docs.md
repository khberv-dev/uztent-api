# Uztent: documentation

The Uztent streaming platform, in one place: how the backend works, its REST and WebSocket APIs, the MediaMTX integration, use cases, and a complete React web client.

- [Overview](#overview)
- [How it works](#how-it-works)
- [Conventions](#conventions)
- [Use cases](#use-cases)
- [REST API](#rest-api)
- [WebSocket events](#websocket-events)
- [MediaMTX integration](#mediamtx-integration)
- [React web client](#react-web-client)
- [Error reference](#error-reference)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)

---

## Overview

Uztent is a live-streaming backend. Streamers broadcast from OBS (or any RTMP encoder) through **MediaMTX**, viewers watch over HLS and **chat** in real time, and every broadcast is kept as a **VOD** together with its chat. The API manages accounts, stream keys, live sessions, viewer counts, chat and recordings, and pushes live changes to clients over a WebSocket.

```
 Streamer (OBS)                                    Viewers (web app)
      │ RTMP  live/<streamId>?key=…                     ▲   │
      ▼                                         HLS     │   │ REST + WebSocket
 ┌──────────┐  auth / online / offline  ┌──────────┐    │   │
 │ MediaMTX │ ────────── webhooks ────▶ │   API    │ ◀──┼───┘
 │          │ ◀──── /v3/paths/list ──── │ (NestJS) │    │
 │  ffmpeg  │       (viewer counts)     └────┬─────┘    │
 │ 1080/720 │                              │      │     │
 │   /480   │ ──────────────── HLS ────────┼──────┼─────┘
 └──────────┘                     ┌────────┘      └────────┐
                                  ▼                        ▼
                         PostgreSQL                     Redis
                         users, sessions,               live sessions,
                         stream keys, VODs              viewer counts, pub/sub
```

The lifecycle of a broadcast:
1. **Setup:** the user generates a stream key (`POST /streams/me/key`) and pastes it into OBS.
2. **Go live:** MediaMTX asks the API to check the key (auth webhook). Once video flows, it reports `online`. The API creates a live session in Redis and broadcasts `stream.started`.
3. **Transcode:** MediaMTX's ffmpeg republishes 1080p, 720p and 480p renditions. Viewers pick one and play it over HLS.
4. **While live:** every 5 s the API reads MediaMTX's reader list, updates `viewers`/`peakViewers` and broadcasts `stream.viewers`.
5. **Chat:** logged-in viewers post with `POST /streams/:id/chat`. Messages are stored in Postgres and pushed to everyone who joined that stream's chat on the WebSocket. The streamer and the moderators they appoint can delete messages and ban users, and the streamer can turn on slow mode.
6. **End:** MediaMTX reports `offline`. The API saves a VOD (same id, title, peak viewers), deletes the live session and broadcasts `stream.ended`. The chat stays attached to the VOD id for replay.

| | |
|---|---|
| Base URL | `http://<host>:<PORT>/<API_PREFIX>`, e.g. `http://localhost:8000/v1` |
| WebSocket | `ws://<host>:<PORT>/ws`, e.g. `ws://localhost:8000/ws` |
| Format | JSON request and response bodies (`Content-Type: application/json`) |
| Auth | `Authorization: Bearer <accessToken>` on every endpoint except the ones marked **Public**. The `/webhooks/*` endpoints are for MediaMTX and are restricted by IP instead. |
| Sign-up | Only through Google. There is no email/password registration. |

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/google` | Public | Sign in or sign up with a Google ID token |
| POST | `/auth/login` | Public | Log in with email or username and a password |
| POST | `/auth/refresh` | Public | Exchange a refresh token for a new token pair |
| POST | `/auth/logout` | Public | Revoke a refresh token (end a session) |
| POST | `/auth/password` | Bearer | Set the first password or change the current one |
| GET | `/users/me` | Bearer | Get the current user's profile |
| PATCH | `/users/me` | Bearer | Update first name, last name or username |
| GET | `/users/username-availability?username=…` | Bearer | Check whether a username is free |
| GET | `/streams/me` | Bearer | Get your stream settings: title, stream key, publish URL |
| PATCH | `/streams/me` | Bearer | Change your stream title or chat slow mode |
| POST | `/streams/me/key` | Bearer | Generate your stream key, or replace it with a new one |
| GET | `/streams` | **Public** | List live streams, newest first |
| GET | `/streams/:idOrUsername` | **Public** | Get one live stream by its id, or a user's live stream by username |
| GET | `/vods/me` | Bearer | List your VODs |
| GET | `/users/:userId/vods` | Bearer | List a user's VODs |
| GET | `/vods/:id` | Bearer | Get one VOD |
| DELETE | `/vods/:id` | Bearer | Delete one of your VODs |
| POST | `/webhooks/mediamtx/auth` | IP allowlist | MediaMTX: may this client publish or read? |
| POST | `/webhooks/mediamtx/online` | IP allowlist | MediaMTX: a broadcast went live |
| POST | `/webhooks/mediamtx/offline` | IP allowlist | MediaMTX: a broadcast ended |
| GET | `/streams/:id/chat` | **Public** | Chat history of a live stream or VOD |
| POST | `/streams/:id/chat` | Bearer | Send a chat message (stream must be live) |
| GET | `/streams/:id/chat/me` | Bearer | Your role in this chat, ban status, slow mode |
| DELETE | `/streams/:id/chat/:messageId` | Bearer | Delete a message (streamer or moderator) |
| POST | `/streams/:id/chat/bans` | Bearer | Ban a user from this streamer's chats (streamer or moderator) |
| DELETE | `/streams/:id/chat/bans/:userId` | Bearer | Unban (streamer or moderator) |
| GET | `/streams/me/moderators` | Bearer | List your chat moderators |
| POST | `/streams/me/moderators` | Bearer | Make a user a moderator of your chat |
| DELETE | `/streams/me/moderators/:userId` | Bearer | Remove a moderator |
| GET | `/streams/me/bans` | Bearer | List users banned from your chat |
| POST | `/streams/me/bans` | Bearer | Ban a user from your chat |
| DELETE | `/streams/me/bans/:userId` | Bearer | Unban a user |
| WS | `/ws` (no API prefix) | **Public** | [Real-time events](#websocket-events): stream started/ended, viewer counts, chat |

---

## How it works

### Accounts

A user is created the first time they sign in with Google. Their name and email come from the Google profile.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Generated by the API |
| `firstName` | string | From Google (`given_name`). Can be changed; can't be empty. |
| `lastName` | string | From Google (`family_name`), or `""` if Google has none. Can be changed. |
| `username` | string \| null | `null` until the user picks one. Unique, stored lowercase, 3–30 characters of `a-z 0-9 _ .` |
| `email` | string | From Google. Unique, stored lowercase, can't be changed through the API. |
| `hasPassword` | boolean | `false` until the user sets a password |
| `createdAt` / `updatedAt` | ISO date-time | |

The password hash and Google account ID are stored but never returned.

### Signing in with Google

The client app runs Google Sign-In and receives a Google **ID token**. It sends that token to `POST /auth/google`. The API then:

1. Verifies the token with Google: the signature, that it hasn't expired, and that its audience is one of `GOOGLE_CLIENT_IDS`.
2. Requires the Google email to be verified.
3. Finds the user:
   - by Google account ID: a returning user;
   - otherwise by email: an existing account that wasn't linked yet, which gets linked to this Google account;
   - otherwise creates a new user.
4. Returns an access token, a refresh token and the user.

### Passwords

A password is optional. Once a user sets one with `POST /auth/password`, they can also log in with `POST /auth/login` using their **email or username**. Passwords are hashed with scrypt.

Setting or changing a password **signs out every session** (all refresh tokens are revoked). The same response returns a fresh token pair, so the device that made the change stays logged in.

### Tokens and sessions

| Token | What it is | Lifetime | Used for |
|---|---|---|---|
| Access token | Signed JWT (`sub` = user id) | `JWT_ACCESS_TTL` seconds (default 900 = 15 min) | `Authorization: Bearer …` header |
| Refresh token | Opaque string `<sessionId>.<secret>` | `REFRESH_TOKEN_TTL_DAYS` days (default 30) | `POST /auth/refresh`, `POST /auth/logout` |

- Each sign-in creates a new **session**, so a user can be signed in on several devices at once.
- Refresh tokens are **single use**. `POST /auth/refresh` ends the old session and returns a new pair. Always store the new refresh token.
- The server stores only a hash of the refresh token, so a leaked database doesn't expose usable tokens.
- Access tokens are checked without a database lookup. A revoked session's access token keeps working until it expires (at most `JWT_ACCESS_TTL`).

### Stream settings (stream key)

Each user has at most **one** stream configuration, stored in the database. It holds the stream's title and tells their encoder (e.g. OBS) where to publish and with which key. It's created the first time the user generates a key and doesn't change between streams.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Public and permanent (kept when the key is replaced). It's the stream's path on the media server, so it's also part of the playback URL. |
| `title` | string | 1–140 characters, default `Untitled stream`. Copied to each live session and its VOD. |
| `chatSlowModeSeconds` | number | Chat slow mode for viewers, 0–3600 s (0 = off). Copied to each live session; changing it while live applies immediately. |
| `streamKey` | string | The secret on its own, e.g. `sk_X3ZOxjLmDS7rjswmX7MLhqAg4SK8y_yM`. Unique. Only ever returned to its owner. |
| `encoderStreamKey` | string | What to paste into the encoder's **Stream Key** field: `<id>?key=<streamKey>` |
| `publishUrl` | string | The ingest server (`STREAM_PUBLISH_URL`), e.g. `rtmp://localhost:1935/live` |
| `createdAt` / `updatedAt` | ISO date-time | `updatedAt` changes each time the key or title changes |

**In OBS:** **Settings → Stream → Service: Custom**, **Server** = `publishUrl`, **Stream Key** = `encoderStreamKey`.
**With ffmpeg or another tool that takes one URL:** `<publishUrl>/<encoderStreamKey>`, e.g. `rtmp://localhost:1935/live/8918071a-…?key=sk_…`.

The stream is published under its **public id**, and the key travels as `?key=`. The media server checks the key with the API before accepting the broadcast, and serves the video at `/live/<id>/index.m3u8`, so the key never appears in a playback URL.

Generating a key again replaces the old one, and new broadcasts need the new key straight away. Use this if the key leaks. A broadcast that's already connected isn't cut off, and it still ends normally.

### Live streams

A live session exists only while the user is broadcasting. It's kept in **Redis**, not in the database. Users don't start or end it through the API. MediaMTX does, through [webhooks](#mediamtx-integration), when a broadcast with a valid key goes live and when it stops.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | New for every broadcast. Later becomes the VOD's `id`. |
| `userId` | uuid | The streamer |
| `title` | string | Copied from the stream settings when publishing starts. `PATCH /streams/me` also renames the live session. |
| `startedAt` | ISO date-time | |
| `viewers` | number | Current viewers across the original and all renditions, read from MediaMTX every `VIEWERS_POLL_SECONDS`. New viewers appear within one poll; viewers who leave are dropped about **40 s** later (MediaMTX keeps an HLS session that long after its last request). |
| `url` | string | HLS URL of the **original** broadcast: `<HLS_BASE_URL>/live/<stream settings id>/index.m3u8`. It's the same for every broadcast by this user. |
| `chatSlowModeSeconds` | number | Current chat slow mode (from the stream settings) |
| `renditions` | array | Transcoded qualities, highest first: `[{ "quality": "1080p", "url": "<HLS_BASE_URL>/watch/<stream settings id>/1080/index.m3u8" }, …]`. The list comes from `STREAM_RENDITIONS`. |

- A user can have **one** live session at a time. If the encoder reconnects while the session is still live, the same session continues.
- Clients learn about streams starting and ending, and about viewer counts, through [WebSocket events](#websocket-events), with no polling needed.

### VODs

When a stream ends, it's saved to the database as a **VOD** (video on demand) with the **same `id`** as the stream.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Same as the stream's `id` |
| `userId` | uuid | The streamer |
| `title` | string | Copied from the stream |
| `previewUri` | string \| null | Thumbnail. `null` until the media pipeline fills it in. |
| `videoUri` | string \| null | Recording. `null` until the media pipeline fills it in. |
| `peakViewers` | number | Highest `viewers` value seen during the stream |
| `startedAt` / `endedAt` | ISO date-time | When the stream started and ended |
| `createdAt` | ISO date-time | |

Deleting a user deletes their VODs.

### Chat

Every live stream has a chat. It's stored in Postgres under the **live stream id**, which becomes the VOD's id, so the chat is kept for replay after the stream ends.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `streamId` | uuid | Live stream id (= VOD id) |
| `userId` | uuid | Sender |
| `senderName` | string | Sender's username, or first name if they have none, at the time of sending |
| `senderRole` | string \| null | Badge at the time of sending: `streamer`, `moderator`, or `null` for viewers |
| `text` | string | 1–500 characters, trimmed |
| `createdAt` | ISO date-time | |

- **Reading** is public: `GET /streams/:id/chat` for history, and the WebSocket (after `chat.join`) for new messages and deletions.
- **Writing** needs login, and only works while the stream is live.
- **Rate limit:** at most one message per `CHAT_MESSAGE_INTERVAL_MS` (default 1000 ms) per user, across all streams. This applies to everyone, including the streamer. Faster messages get `429`.
- **Slow mode:** the streamer sets `chatSlowModeSeconds` on their stream settings. Viewers then wait that long between messages in that channel (`429` with the remaining seconds). The streamer and moderators are exempt. Changes apply immediately and are pushed as `chat.settings`.
- **Roles** are per channel (per streamer):
  - **Streamer:** the stream's owner. Can do everything, and manages moderators and bans in settings.
  - **Moderator:** appointed by the streamer. Can delete messages and ban or unban viewers in all of the streamer's chats, live and VOD. Can't ban the streamer or other moderators.
  - **Viewer:** everyone else who is logged in.
- **Deleting** is permanent and pushed live as `chat.deleted`.
- **Bans** are per channel: a banned user can't write in **any** of that streamer's streams until unbanned. Banned users can still read, and their earlier messages stay unless deleted.
  - When the streamer bans a moderator, the moderator role is removed too.
  - Making a banned user a moderator lifts the ban.
- `GET /streams/:id/chat/me` tells a client the user's role, ban status and the current slow mode, so it can show the right controls.
- Deleting a VOD deletes its chat. Deleting a user deletes their messages and bans.

---

## Conventions

- **Unknown fields are rejected.** Any field that isn't documented for an endpoint returns `400` (`property <name> should not exist`).
- **Case-insensitive lookups.** Emails and usernames are stored and looked up in lowercase, so `Aziz_K` and `aziz_k` are the same username.
- **Paginated lists** take `?page=` (default `1`) and `?limit=` (default `20`, max `100`), and return:
  ```json
  { "items": [ … ], "total": 42, "page": 1, "limit": 20 }
  ```
- **IDs in paths** must be UUIDs; anything else returns `400 Validation failed (uuid is expected)`.
- **Error format** (standard NestJS):
  ```json
  { "message": "Invalid credentials", "error": "Unauthorized", "statusCode": 401 }
  ```
  For validation errors (`400`), `message` is an array of strings:
  ```json
  { "message": ["password should not be empty"], "error": "Bad Request", "statusCode": 400 }
  ```
  When a request has no token or an invalid one, the body is just `{ "message": "Unauthorized", "statusCode": 401 }`.

---

## Use cases

### 1. New user signs in with Google for the first time

1. The app shows the Google Sign-In button and receives an ID token.
2. `POST /auth/google { idToken }` returns **200**, and a new user is created.
3. The response has `username: null` and `hasPassword: false`. The app can now ask the user to pick a username (`PATCH /users/me`) and, optionally, set a password (`POST /auth/password`).

### 2. Returning user signs in with Google

Same call as above. The user is found by their Google account ID, and a new session is created. Profile changes made in the app, such as a new name, are **not** overwritten by Google data.

### 3. Existing account gets linked to Google

If a user with the same email exists but has never signed in with Google, the Google account is linked to it automatically. Google has confirmed the email, so it's safe to link. From then on, both Google sign-in and their password (if set) work.

### 4. User sets a password, then logs in with username

1. Signed in via Google: `POST /auth/password { newPassword }` returns **200** with a new token pair. No `currentPassword` is needed the first time.
2. Later, on a new device: `POST /auth/login { login: "aziz_k", password }` returns **200**. An email address works in `login` too.

### 5. User changes their password

`POST /auth/password { currentPassword, newPassword }` returns **200**.
- Every other device is signed out: its refresh token stops working, and its access token expires within `JWT_ACCESS_TTL`.
- The calling device must replace both of its tokens with the new pair from the response.

### 6. Access token expires

1. Any call returns **401**.
2. The app calls `POST /auth/refresh { refreshToken }` and gets **200** with a new pair. It stores both tokens and retries the original call.
3. If refresh also returns **401** (the session expired, was revoked or was already used), the app sends the user back to sign-in.

### 7. User logs out

`POST /auth/logout { refreshToken }` returns **204**. Then delete both tokens on the device. Other devices stay signed in.

### 8. User picks a username

1. While the user types, the app calls `GET /users/username-availability?username=aziz` (debounced, e.g. 300 ms after the last keystroke) and shows "available" or "taken".
2. When the user confirms, the app calls `PATCH /users/me { username: "aziz" }`.
3. The check is only a hint: someone else can take the name between the check and the save. In that case `PATCH` returns **409** `Username is already taken`, and the app should ask for another one.

### 9. User sets up streaming (once)

1. `POST /streams/me/key` returns **200** with `publishUrl` and `encoderStreamKey`.
2. The user puts them in OBS (**Server** and **Stream Key**). Later, `GET /streams/me` shows them again.
3. `PATCH /streams/me { title }` sets the title for upcoming broadcasts.
4. If the key leaks, `POST /streams/me/key` again returns a new key. The user pastes the new `encoderStreamKey` into OBS.

### 10. User goes live

1. The user clicks **Start Streaming** in OBS, which connects to MediaMTX at `live/<id>?key=…`.
2. MediaMTX calls `POST /webhooks/mediamtx/auth`. The API checks the key and returns **204**, and MediaMTX accepts the broadcast. A wrong key gets **401**, and MediaMTX drops the connection before anything is broadcast.
3. Once video is flowing, MediaMTX calls `POST /webhooks/mediamtx/online`, and the API starts a live session with the stream's title.
4. Every connected client receives a `stream.started` event with the full stream, so home pages and channel pages update immediately.
5. Viewers play one of its `renditions` (or `url` for the original) in an HLS player.
6. The user can rename the broadcast while live with `PATCH /streams/me { title }`.

### 11. User ends the stream

1. The user clicks **Stop Streaming**, or the encoder disconnects.
2. MediaMTX calls `POST /webhooks/mediamtx/offline`. The API removes the live session and saves it as a VOD. The stream disappears from `GET /streams`, and `GET /streams/:id` returns 404.
3. Every connected client receives `stream.ended` (with `vodId`), so players can show "Stream ended" and link to the recording.
4. The VOD shows up in `GET /vods/me` and `GET /users/:userId/vods` straight away. `previewUri` and `videoUri` stay `null` until the recording is processed.

### 12. User deletes a recording

`DELETE /vods/:id` returns **204**. Deleting someone else's VOD returns **403**.

### 13. Home page shows what's live, in real time

1. The page loads `GET /streams` (public, so no login needed) and opens the WebSocket.
2. `stream.started` adds a card, `stream.ended` removes it, and `stream.viewers` (every 5 s) updates the counts.
3. If the WebSocket drops, the client reconnects and reloads `GET /streams` to catch up on events it missed.

### 14. Visitor opens a channel page

1. `GET /streams/aziz_k` returns **200** (live), **404 `User is not live`** (show "offline") or **404 `User not found`**.
2. While the channel is live, `stream.viewers` updates the viewer count and `stream.ended` switches the page to "offline".
3. While it's offline, each `stream.started` makes the page re-check `GET /streams/aziz_k`. Events carry `userId`, not `username`.


### 15. Viewer chats during a stream

1. The player page loads `GET /streams/:id/chat` (public) and sends `chat.join` over the WebSocket.
2. A logged-in viewer sends `POST /streams/:id/chat { text }` and gets **201** with the message. Everyone in the chat, including the sender, receives `chat.message`.
3. Sending again too soon gets **429**: `You are sending messages too fast` (global limit), or `Slow mode is on: wait N s before your next message` if the streamer turned on slow mode. Sending after the stream ended gets **404** `Stream not found`.
4. Logged-out visitors can read the chat but not write.

### 16. Streamer or moderator moderates the chat

1. The client calls `GET /streams/:id/chat/me`. If `canModerate` is true, it shows Delete and Ban buttons on messages.
2. Delete: `DELETE /streams/:id/chat/:messageId` returns **204**, and everyone in the chat receives `chat.deleted`. Viewers get **403**.
3. Ban the sender by `userId` (from the message): `POST /streams/:id/chat/bans { userId }` returns **204**. Their next message gets **403** `You are banned from this chat`, in this and every future stream of this streamer.
4. A moderator trying to ban another moderator gets **403**, and trying to ban the streamer gets **400**.
5. The streamer manages everything in settings: `GET /streams/me/bans`, `POST /streams/me/bans`, `DELETE /streams/me/bans/:userId`.

### 18. Streamer appoints a moderator

1. The streamer picks a trusted viewer (e.g. from a chat message's `userId`) and calls `POST /streams/me/moderators { userId }`, which returns **204**. If that user was banned, the ban is lifted.
2. From the next message on, the moderator's messages carry `senderRole: "moderator"`. They're exempt from slow mode, and `GET /streams/:id/chat/me` returns `canModerate: true`.
3. `DELETE /streams/me/moderators/:userId` removes the role. Banning a moderator from settings also removes it.

### 19. Streamer turns on slow mode

1. Mid-stream, the streamer calls `PATCH /streams/me { "chatSlowModeSeconds": 30 }`.
2. Everyone in the chat receives `chat.settings { slowModeSeconds: 30 }`, and the client shows "Slow mode: one message every 30 s".
3. Viewers posting faster get **429** `Slow mode is on: wait N s before your next message`. The streamer and moderators aren't affected.
4. `PATCH /streams/me { "chatSlowModeSeconds": 0 }` turns it off. The setting is kept for future streams.

### 17. Watching a VOD with its chat

The VOD has the same id as the live stream, so `GET /streams/<vodId>/chat` returns the chat as it was. Page back through older messages with `before` (the oldest `createdAt` you have). The streamer and moderators can still delete messages there.

---

## REST API

All paths are relative to the base URL, e.g. `POST /auth/google` means `POST http://localhost:8000/v1/auth/google`.

### POST /auth/google

**Public.** Sign in or sign up with a Google ID token.

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `idToken` | string | yes | The Google ID token (a JWT) from Google Sign-In |

```http
POST /v1/auth/google
Content-Type: application/json

{
  "idToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6Ij..."
}
```

**200 OK**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ZjNj...",
  "refreshToken": "c1a2b3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d.Qm9xZ2Z0aG9vX1JhbmRvbV9TZWNyZXQ",
  "user": {
    "id": "7f3c9a2e-1b4d-4e8f-9a6b-2c5d8e1f0a3b",
    "firstName": "Aziz",
    "lastName": "Karimov",
    "username": null,
    "email": "aziz.karimov@gmail.com",
    "createdAt": "2026-11-13T09:15:42.118Z",
    "updatedAt": "2026-11-13T09:15:42.118Z",
    "hasPassword": false
  }
}
```

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["idToken must be a jwt string"]` | Missing, or not a JWT |
| 401 | `Invalid Google token` | Expired, bad signature, or issued for a client ID not in `GOOGLE_CLIENT_IDS` |
| 401 | `Google account email is not verified` | The Google account's email isn't verified |

**Where the ID token comes from**

- **Web:** Google Identity Services. `google.accounts.id.initialize({ client_id, callback })`; the token is in `response.credential`. With React and `@react-oauth/google`, use `<GoogleLogin onSuccess={r => r.credential} />` (not `useGoogleLogin`, which returns an access token instead).
- **Android:** Credential Manager with `GetGoogleIdOption`, using the **web** client ID as `serverClientId`.
- **iOS:** the GoogleSignIn SDK, sending `user.idToken.tokenString`.
- **Manual testing:** OAuth 2.0 Playground with **your own** OAuth credentials and the scopes `openid email profile`. Copy `id_token` from the token exchange.

```bash
curl -X POST http://localhost:8000/v1/auth/google \
  -H 'Content-Type: application/json' \
  -d '{"idToken":"<google_id_token>"}'
```

---

### POST /auth/login

**Public.** Log in with a password. Works only after the user has set one.

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `login` | string | yes | Email (if it contains `@`) or username. Case-insensitive, max 254 characters. |
| `password` | string | yes | Max 128 characters |

```http
POST /v1/auth/login
Content-Type: application/json

{
  "login": "aziz_k",
  "password": "correct horse battery"
}
```

**200 OK:** same shape as [`POST /auth/google`](#post-authgoogle).

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "5b8e2f10-3c4d-4a5b-9e6f-7a8b9c0d1e2f.dGhpc19pc19hX3JhbmRvbV9zZWNyZXQ",
  "user": {
    "id": "7f3c9a2e-1b4d-4e8f-9a6b-2c5d8e1f0a3b",
    "firstName": "Aziz",
    "lastName": "Karimov",
    "username": "aziz_k",
    "email": "aziz.karimov@gmail.com",
    "createdAt": "2026-11-13T09:15:42.118Z",
    "updatedAt": "2026-11-13T10:02:11.540Z",
    "hasPassword": true
  }
}
```

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["password should not be empty"]` etc. | Missing or empty fields |
| 401 | `Invalid credentials` | No such user, the user has no password yet, or the password is wrong. These cases aren't told apart. |

---

### POST /auth/refresh

**Public.** Exchange a refresh token for a new access token and refresh token. The old refresh token is invalidated.

**Request body**

| Field | Type | Required |
|---|---|---|
| `refreshToken` | string | yes |

```http
POST /v1/auth/refresh
Content-Type: application/json

{
  "refreshToken": "c1a2b3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d.Qm9xZ2Z0aG9vX1JhbmRvbV9TZWNyZXQ"
}
```

**200 OK:** a new `accessToken`, a new `refreshToken`, and the `user` object (same shape as [`POST /auth/google`](#post-authgoogle)).

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["refreshToken should not be empty", "refreshToken must be a string"]` | Missing |
| 401 | `Invalid refresh token` | Malformed, unknown, already used, revoked, expired, or the user no longer exists |

---

### POST /auth/logout

**Public.** End the session that a refresh token belongs to. Other sessions aren't affected.

```http
POST /v1/auth/logout
Content-Type: application/json

{
  "refreshToken": "c1a2b3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d.Qm9xZ2Z0aG9vX1JhbmRvbV9TZWNyZXQ"
}
```

**204 No Content:** returned even if the token was already invalid, so logging out can be retried safely.

**Errors:** `400` only if `refreshToken` is missing.

---

### POST /auth/password

**Bearer.** Set the first password, or change the current one. All of the user's sessions are revoked and a new token pair is returned.

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `currentPassword` | string | only if `hasPassword` is `true` | |
| `newPassword` | string | yes | 8–128 characters |

**Set the first password**

```http
POST /v1/auth/password
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "newPassword": "correct horse battery"
}
```

**Change the password**

```http
POST /v1/auth/password
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "currentPassword": "correct horse battery",
  "newPassword": "even more correct horse"
}
```

**200 OK:** a new token pair and the user, now with `"hasPassword": true`. Replace the tokens stored on the device.

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a.bmV3X3JlZnJlc2hfc2VjcmV0",
  "user": {
    "id": "7f3c9a2e-1b4d-4e8f-9a6b-2c5d8e1f0a3b",
    "firstName": "Aziz",
    "lastName": "Karimov",
    "username": "aziz_k",
    "email": "aziz.karimov@gmail.com",
    "createdAt": "2026-11-13T09:15:42.118Z",
    "updatedAt": "2026-11-13T10:00:03.927Z",
    "hasPassword": true
  }
}
```

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["newPassword must be longer than or equal to 8 characters"]` | `newPassword` too short, too long or missing |
| 400 | `currentPassword is required` | The user already has a password and `currentPassword` wasn't sent |
| 401 | `Current password is incorrect` | `currentPassword` is wrong |
| 401 | `Unauthorized` | Missing or invalid access token |
| 404 | `User not found` | The account was deleted while the token was still valid |

---

### GET /users/me

**Bearer.** The current user's profile.

```http
GET /v1/users/me
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**200 OK**

```json
{
  "id": "7f3c9a2e-1b4d-4e8f-9a6b-2c5d8e1f0a3b",
  "firstName": "Aziz",
  "lastName": "Karimov",
  "username": "aziz_k",
  "email": "aziz.karimov@gmail.com",
  "createdAt": "2026-11-13T09:15:42.118Z",
  "updatedAt": "2026-11-13T10:02:11.540Z",
  "hasPassword": true
}
```

**Errors:** `401 Unauthorized` (missing or invalid token), `404 User not found`.

---

### PATCH /users/me

**Bearer.** Update the profile. Send only the fields to change.

**Request body**

| Field | Type | Rules |
|---|---|---|
| `firstName` | string | 1–100 characters. `null` and `""` are rejected. |
| `lastName` | string | 0–100 characters. `""` is allowed; `null` is rejected. |
| `username` | string \| null | 3–30 characters of `a-z 0-9 _ .`. Converted to lowercase and trimmed. Must be unique. `null` removes the username. |

```http
PATCH /v1/users/me
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "firstName": "Aziz",
  "username": "Aziz_K"
}
```

**200 OK:** the updated profile.

```json
{
  "id": "7f3c9a2e-1b4d-4e8f-9a6b-2c5d8e1f0a3b",
  "firstName": "Aziz",
  "lastName": "Karimov",
  "username": "aziz_k",
  "email": "aziz.karimov@gmail.com",
  "createdAt": "2026-11-13T09:15:42.118Z",
  "updatedAt": "2026-11-13T10:02:11.540Z",
  "hasPassword": false
}
```

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["username must be 3-30 characters: letters, digits, underscores or dots"]` | Invalid username |
| 400 | `["firstName should not be empty"]` | `firstName` is `""` or `null` |
| 400 | `["property email should not exist"]` | Trying to change a field that can't be changed |
| 401 | `Unauthorized` | Missing or invalid access token |
| 404 | `User not found` | The account was deleted |
| 409 | `Username is already taken` | Another user has that username |

---

### GET /users/username-availability

**Bearer.** Check whether a username can be used before saving it with [`PATCH /users/me`](#patch-usersme).

**Query parameters**

| Name | Type | Required | Rules |
|---|---|---|---|
| `username` | string | yes | Same rules as `PATCH /users/me`: 3–30 characters of `a-z 0-9 _ .`. Trimmed and lowercased before checking. |

```http
GET /v1/users/username-availability?username=Aziz_K
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**200 OK: available**

```json
{
  "username": "aziz_k",
  "available": true
}
```

**200 OK: taken by another user**

```json
{
  "username": "aziz_k",
  "available": false
}
```

- `username` is the normalized value that was checked. Show it to the user, since that's what will be saved.
- The caller's **own** current username is reported as `available: true`.
- The result isn't a reservation. A later `PATCH /users/me` can still return `409` if someone takes the name in between.

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["username must be 3-30 characters: letters, digits, underscores or dots"]` | Missing, too short or too long, or has invalid characters |
| 400 | `["property foo should not exist"]` | Unknown query parameter |
| 401 | `Unauthorized` | Missing or invalid access token |

```bash
curl -G http://localhost:8000/v1/users/username-availability \
  --data-urlencode 'username=Aziz_K' \
  -H 'Authorization: Bearer <accessToken>'
```

---

### GET /streams/me

**Bearer.** The caller's stream settings: title, stream key, encoder stream key and publish URL.

```http
GET /v1/streams/me
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**200 OK**

```json
{
  "id": "8918071a-bcf3-4445-9a0e-f1b057c1d3ad",
  "title": "Friday night ranked",
  "chatSlowModeSeconds": 0,
  "streamKey": "sk_ZDfWm48KMkwbM1xnOlGe0Dsn36A_yY06",
  "publishUrl": "rtmp://localhost:1935/live",
  "createdAt": "2026-11-13T05:38:45.521Z",
  "updatedAt": "2026-11-13T05:38:45.521Z",
  "encoderStreamKey": "8918071a-bcf3-4445-9a0e-f1b057c1d3ad?key=sk_ZDfWm48KMkwbM1xnOlGe0Dsn36A_yY06"
}
```

**Errors**

| Status | `message` | When |
|---|---|---|
| 401 | `Unauthorized` | Missing or invalid access token |
| 404 | `No stream key yet. Generate one with POST /streams/me/key` | The user has never generated a key |

---

### PATCH /streams/me

**Bearer.** Change the stream title and/or chat slow mode. Send only the fields to change. Changes apply to future broadcasts, and to the current live session if the user is live. A slow mode change is pushed to the chat as `chat.settings`.

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `title` | string | no | 1–140 characters |
| `chatSlowModeSeconds` | number | no | Integer 0–3600; `0` turns slow mode off |

```http
PATCH /v1/streams/me
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "title": "Friday night ranked",
  "chatSlowModeSeconds": 30
}
```

**200 OK:** the updated settings, same shape as [`GET /streams/me`](#get-streamsme).

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["title should not be empty", …]` | `title` empty or longer than 140 characters |
| 400 | `["chatSlowModeSeconds must not be greater than 3600"]` | Slow mode out of range or not an integer |
| 401 | `Unauthorized` | Missing or invalid access token |
| 404 | `No stream key yet. Generate one with POST /streams/me/key` | No stream settings yet |

---

### POST /streams/me/key

**Bearer.** Generate the caller's stream key. The first call creates the stream settings; later calls replace the key and keep the `id` and title. New broadcasts need the new key immediately; a broadcast that's already connected isn't cut off. No request body.

```http
POST /v1/streams/me/key
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**200 OK:** the same shape as [`GET /streams/me`](#get-streamsme), with the new key.

```json
{
  "id": "8918071a-bcf3-4445-9a0e-f1b057c1d3ad",
  "title": "Friday night ranked",
  "chatSlowModeSeconds": 0,
  "streamKey": "sk_X3ZOxjLmDS7rjswmX7MLhqAg4SK8y_yM",
  "publishUrl": "rtmp://localhost:1935/live",
  "createdAt": "2026-11-13T05:38:45.521Z",
  "updatedAt": "2026-11-13T05:38:45.544Z",
  "encoderStreamKey": "8918071a-bcf3-4445-9a0e-f1b057c1d3ad?key=sk_X3ZOxjLmDS7rjswmX7MLhqAg4SK8y_yM"
}
```

**Errors:** `401 Unauthorized`.

---

### GET /streams

**Public.** Live streams, newest first. [Paginated](#conventions). To keep the list current, load it once and then apply [WebSocket events](#websocket-events).

```http
GET /v1/streams?page=1&limit=20
```

**200 OK**

```json
{
  "items": [
    {
      "id": "f3b9914e-5d28-4d39-b2df-98df0f3a5634",
      "userId": "ad3d1da7-642a-40c2-8500-3d04db5b1880",
      "title": "Friday night ranked",
      "startedAt": "2026-11-13T05:26:21.982Z",
      "viewers": 0,
      "url": "http://localhost:8888/live/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/index.m3u8",
      "renditions": [
        { "quality": "1080p", "url": "http://localhost:8888/watch/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/1080/index.m3u8" },
        { "quality": "720p", "url": "http://localhost:8888/watch/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/720/index.m3u8" },
        { "quality": "480p", "url": "http://localhost:8888/watch/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/480/index.m3u8" }
      ],
      "chatSlowModeSeconds": 0
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

**Errors:** `400` for an invalid `page` or `limit` (e.g. `["limit must not be greater than 100"]`).

---

### GET /streams/:idOrUsername

**Public: no access token needed**, so channel pages like `/@aziz_k` work for logged-out visitors. One route, two lookups:

- **A UUID** returns the live stream with that `id`.
- **Anything else** is treated as a **username** (case-insensitive) and returns that user's current live stream. Usernames can't contain `-`, so they never look like a UUID.

```http
GET /v1/streams/aziz_k
```

```http
GET /v1/streams/97e495ba-4a54-47b0-be69-617820983d40
```

**200 OK:** the live stream, same shape as one item of [`GET /streams`](#get-streams).

```json
{
  "id": "97e495ba-4a54-47b0-be69-617820983d40",
  "userId": "ad3d1da7-642a-40c2-8500-3d04db5b1880",
  "title": "Friday night ranked",
  "startedAt": "2026-11-13T06:35:13.851Z",
  "viewers": 0,
  "url": "http://localhost:8888/live/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/index.m3u8",
  "renditions": [
    { "quality": "1080p", "url": "http://localhost:8888/watch/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/1080/index.m3u8" },
    { "quality": "720p", "url": "http://localhost:8888/watch/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/720/index.m3u8" },
    { "quality": "480p", "url": "http://localhost:8888/watch/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/480/index.m3u8" }
  ],
  "chatSlowModeSeconds": 0
}
```

**Errors**

| Status | `message` | When |
|---|---|---|
| 404 | `Stream not found` | By id: no such live stream, or it has ended (look for a VOD with the same `id`) |
| 404 | `User not found` | By username: no user has this username |
| 404 | `User is not live` | By username: the user exists but isn't broadcasting right now |

`/streams/me` (your stream settings) is a separate route and still needs a token. `me` can't be a username, because usernames are at least 3 characters.

---

### GET /streams/:id/chat

**Public.** Chat history of a live stream, or of a VOD (same id). Returns the newest messages, **oldest first** (ready to render top to bottom).

**Query parameters**

| Name | Type | Default | Rules |
|---|---|---|---|
| `limit` | number | `50` | 1–100 |
| `before` | ISO date-time | | Only messages older than this. Pass the oldest `createdAt` you have to page back. |

```http
GET /v1/streams/d9b86c2e-2ddb-42d4-b204-5d0f18f067b5/chat?limit=2
```

**200 OK**

```json
{
  "items": [
    {
      "id": "0b6f5a0e-8a51-4c64-9d1c-0d5c0f8e7a21",
      "streamId": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5",
      "userId": "5d3b1e0c-6c2a-4f0e-9b8a-1f2e3d4c5b6a",
      "senderName": "aziz_k",
      "senderRole": "streamer",
      "text": "gg",
      "createdAt": "2026-11-13T08:04:11.402Z"
    },
    {
      "id": "7c9e2d14-1f3b-4a5e-8d6c-2b1a0f9e8d7c",
      "streamId": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5",
      "userId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      "senderName": "Viewer",
      "senderRole": null,
      "text": "hello chat",
      "createdAt": "2026-11-13T08:04:13.877Z"
    }
  ],
  "hasMore": true
}
```

`hasMore: true` means older messages exist: request again with `before=2026-11-13T08:04:11.402Z`. An unknown id returns an empty list.

**Errors:** `400` if `id` isn't a UUID, or `limit`/`before` is invalid.

---

### POST /streams/:id/chat

**Bearer.** Send a message to a **live** stream's chat. It's pushed to everyone who joined the chat, including the sender.

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `text` | string | yes | 1–500 characters after trimming |

```http
POST /v1/streams/d9b86c2e-2ddb-42d4-b204-5d0f18f067b5/chat
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "text": "  hello chat  "
}
```

**201 Created**

```json
{
  "id": "7c9e2d14-1f3b-4a5e-8d6c-2b1a0f9e8d7c",
  "streamId": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5",
  "userId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "senderName": "Viewer",
  "senderRole": null,
  "text": "hello chat",
  "createdAt": "2026-11-13T08:04:13.877Z"
}
```

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["text should not be empty"]` / `["text must be shorter than or equal to 500 characters"]` | Empty after trimming, or too long |
| 401 | `Unauthorized` | Missing or invalid access token |
| 403 | `You are banned from this chat` | The streamer banned the caller |
| 404 | `Stream not found` | Not live (never was, or already ended) |
| 429 | `You are sending messages too fast` | Less than `CHAT_MESSAGE_INTERVAL_MS` since the caller's previous message (any chat) |
| 429 | `Slow mode is on: wait 25 s before your next message` | Slow mode, viewers only |

---

### DELETE /streams/:id/chat/:messageId

**Bearer, streamer or moderator.** Delete a message, live or on the VOD. Everyone in the chat receives `chat.deleted`.

```http
DELETE /v1/streams/d9b86c2e-2ddb-42d4-b204-5d0f18f067b5/chat/7c9e2d14-1f3b-4a5e-8d6c-2b1a0f9e8d7c
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**204 No Content**

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `id` or `messageId` isn't a UUID |
| 401 | `Unauthorized` | Missing or invalid access token |
| 403 | `Only the streamer and moderators can do this` | The caller is a viewer |
| 404 | `Message not found` | No such message in this stream (or already deleted) |

---

### GET /streams/:id/chat/me

**Bearer.** The caller's permissions in this chat (live stream or VOD). Use it to decide which controls to show.

```http
GET /v1/streams/d9b86c2e-2ddb-42d4-b204-5d0f18f067b5/chat/me
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**200 OK**

```json
{
  "role": "moderator",
  "banned": false,
  "slowModeSeconds": 30,
  "canModerate": true
}
```

| Field | Meaning |
|---|---|
| `role` | `streamer`, `moderator` or `viewer` |
| `banned` | Can't send messages (always `false` for the streamer and moderators) |
| `slowModeSeconds` | Current slow mode while live (`0` when off, or for a VOD). Applies to viewers only. |
| `canModerate` | May delete messages and ban or unban |

**Errors:** `401`, and `404` (`Stream not found` / `VOD not found`) for an unknown id.

---

### POST /streams/:id/chat/bans

**Bearer, streamer or moderator.** Ban a user from all chats of this stream's owner. Works from a live stream or a VOD. Banning an already banned user also returns `204`.

```http
POST /v1/streams/d9b86c2e-2ddb-42d4-b204-5d0f18f067b5/chat/bans
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "userId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
}
```

**204 No Content**

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `The streamer can't be banned` / `You can't ban yourself` | Target is the streamer |
| 403 | `Only the streamer and moderators can do this` | The caller is a viewer |
| 403 | `Moderators can't ban other moderators` | A moderator targeting a moderator (the streamer can, which removes the role) |
| 404 | `User not found` / `Stream not found` | Unknown user or stream |

---

### DELETE /streams/:id/chat/bans/:userId

**Bearer, streamer or moderator.** Lift a ban in this stream owner's chats. Returns `204` even if the user wasn't banned.

```http
DELETE /v1/streams/d9b86c2e-2ddb-42d4-b204-5d0f18f067b5/chat/bans/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**204 No Content.** **Errors:** `403` for viewers.

---

### GET /streams/me/moderators

**Bearer.** The caller's chat moderators, most recently added first.

```http
GET /v1/streams/me/moderators
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**200 OK**

```json
[
  {
    "userId": "5f0e9d8c-7b6a-4f5e-9d4c-3b2a1f0e9d8c",
    "username": "chat_mod",
    "firstName": "Mod",
    "lastName": "T",
    "since": "2026-11-13T08:41:02.556Z"
  }
]
```

---

### POST /streams/me/moderators

**Bearer.** Make a user a moderator of all the caller's chats. If they were banned, the ban is lifted. Promoting an existing moderator also returns `204`.

```http
POST /v1/streams/me/moderators
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "userId": "5f0e9d8c-7b6a-4f5e-9d4c-3b2a1f0e9d8c"
}
```

**204 No Content**

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["userId must be a UUID"]` | Invalid `userId` |
| 400 | `You are already the streamer of your channel` | `userId` is the caller |
| 404 | `User not found` | No such user |

---

### DELETE /streams/me/moderators/:userId

**Bearer.** Remove a moderator. Returns `204` even if they weren't one.

```http
DELETE /v1/streams/me/moderators/5f0e9d8c-7b6a-4f5e-9d4c-3b2a1f0e9d8c
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**204 No Content**

---

### GET /streams/me/bans

**Bearer.** Users banned from the caller's chat, newest ban first.

```http
GET /v1/streams/me/bans
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**200 OK**

```json
[
  {
    "userId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    "username": null,
    "firstName": "Viewer",
    "lastName": "T",
    "since": "2026-11-13T08:06:40.120Z"
  }
]
```

---

### POST /streams/me/bans

**Bearer.** Ban a user from the caller's chat, in all of the caller's streams. Banning someone who is already banned also returns `204`. Banning one of your moderators also removes the moderator role.

```http
POST /v1/streams/me/bans
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "userId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
}
```

**204 No Content**

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["userId must be a UUID"]` | Invalid `userId` |
| 400 | `You can't ban yourself` | `userId` is the caller |
| 404 | `User not found` | No such user |

---

### DELETE /streams/me/bans/:userId

**Bearer.** Lift a ban. Returns `204` even if the user wasn't banned.

```http
DELETE /v1/streams/me/bans/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**204 No Content**

---

### GET /vods/me

**Bearer.** The caller's VODs, newest first. [Paginated](#conventions).

```http
GET /v1/vods/me?page=1&limit=20
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**200 OK**

```json
{
  "items": [
    {
      "id": "f3b9914e-5d28-4d39-b2df-98df0f3a5634",
      "userId": "ad3d1da7-642a-40c2-8500-3d04db5b1880",
      "title": "Friday night ranked",
      "previewUri": null,
      "videoUri": null,
      "peakViewers": 0,
      "startedAt": "2026-11-13T05:26:21.982Z",
      "endedAt": "2026-11-13T07:41:09.310Z",
      "createdAt": "2026-11-13T07:41:09.315Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

**Errors:** `400` for an invalid `page` or `limit`, and `401`.

---

### GET /users/:userId/vods

**Bearer.** Any user's VODs, newest first. [Paginated](#conventions). Same response shape as [`GET /vods/me`](#get-vodsme).

```http
GET /v1/users/ad3d1da7-642a-40c2-8500-3d04db5b1880/vods?page=1&limit=5
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Errors:** `400` if `userId` isn't a UUID or `page`/`limit` is invalid, and `401`. An unknown user returns an empty list, not 404.

---

### GET /vods/:id

**Bearer.** One VOD.

```http
GET /v1/vods/f3b9914e-5d28-4d39-b2df-98df0f3a5634
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**200 OK:** the same object as one item of [`GET /vods/me`](#get-vodsme).

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `id` isn't a UUID |
| 401 | `Unauthorized` | Missing or invalid access token |
| 404 | `VOD not found` | No such VOD |

---

### DELETE /vods/:id

**Bearer.** Delete one of the caller's VODs.

```http
DELETE /v1/vods/f3b9914e-5d28-4d39-b2df-98df0f3a5634
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**204 No Content**

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `id` isn't a UUID |
| 401 | `Unauthorized` | Missing or invalid access token |
| 403 | `You can only delete your own VODs` | The VOD belongs to someone else |
| 404 | `VOD not found` | No such VOD |

---

## WebSocket events

Live stream changes are pushed to clients over a WebSocket, so nobody needs to poll.

| | |
|---|---|
| URL | `ws://<host>:<PORT>/ws`, e.g. `ws://localhost:8000/ws`. **Not** under `API_PREFIX`. Use `wss://` behind TLS. |
| Auth | None: the events are public (the same data as the public `GET /streams`) |
| Direction | Mostly server → client. Clients only send `chat.join` / `chat.leave` to pick which chats they receive. |
| Format | Text frames with JSON: `{ "event": "<name>", "data": … }` |
| Keep-alive | The server pings every 30 s and closes connections that don't answer. Browsers answer automatically. |

`stream.*` events go to **every** client. `chat.message`, `chat.deleted` and `chat.settings` go only to clients that joined that stream's chat.

### `stream.started`

A broadcast went live. `data` is the full live stream, the same shape as [`GET /streams/:idOrUsername`](#get-streamsidorusername).

```json
{
  "event": "stream.started",
  "data": {
    "id": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5",
    "userId": "de961389-2cbd-46cc-9f4a-1cf6e5c395f1",
    "title": "Friday night ranked",
    "startedAt": "2026-11-13T07:02:10.418Z",
    "viewers": 0,
    "url": "http://localhost:8888/live/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/index.m3u8",
    "renditions": [
      { "quality": "1080p", "url": "http://localhost:8888/watch/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/1080/index.m3u8" },
      { "quality": "720p", "url": "http://localhost:8888/watch/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/720/index.m3u8" },
      { "quality": "480p", "url": "http://localhost:8888/watch/8918071a-bcf3-4445-9a0e-f1b057c1d3ad/480/index.m3u8" }
    ],
    "chatSlowModeSeconds": 0
  }
}
```

An encoder reconnecting during the same session doesn't send a second `stream.started`.

### `stream.ended`

A broadcast stopped. The recording is now a VOD with id `vodId`, which is the same as `id`.

```json
{
  "event": "stream.ended",
  "data": {
    "id": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5",
    "userId": "de961389-2cbd-46cc-9f4a-1cf6e5c395f1",
    "vodId": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5"
  }
}
```

### `stream.viewers`

Sent every `VIEWERS_POLL_SECONDS` (5 s) while at least one stream is live. It holds the current count for **every** live stream, not just the ones that changed.

```json
{
  "event": "stream.viewers",
  "data": [
    { "id": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5", "viewers": 12 },
    { "id": "579c12c4-8e02-4347-ba06-43f43297c691", "viewers": 0 }
  ]
}
```

### Joining a chat

Send these over the socket to receive one stream's chat. A connection can be in up to 10 chats. Joins belong to the connection, so join again after reconnecting.

```json
{ "event": "chat.join", "data": { "streamId": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5" } }
```

```json
{ "event": "chat.leave", "data": { "streamId": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5" } }
```

The server replies `{ "event": "chat.joined" | "chat.left", "data": { "streamId": "…" } }`, or with an error:

```json
{ "event": "error", "data": { "message": "chat.join needs data.streamId (uuid)" } }
```

```json
{ "event": "error", "data": { "message": "At most 10 chats per connection" } }
```

### `chat.message`

A new message in a chat you joined. `data` has the same shape as `POST /streams/:id/chat`'s response.

```json
{
  "event": "chat.message",
  "data": {
    "id": "7c9e2d14-1f3b-4a5e-8d6c-2b1a0f9e8d7c",
    "streamId": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5",
    "userId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    "senderName": "Viewer",
    "senderRole": null,
    "text": "hello chat",
    "createdAt": "2026-11-13T08:04:13.877Z"
  }
}
```

### `chat.deleted`

The streamer removed a message. Remove it from the screen.

```json
{ "event": "chat.deleted", "data": { "id": "7c9e2d14-1f3b-4a5e-8d6c-2b1a0f9e8d7c", "streamId": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5" } }
```

### `chat.settings`

The streamer changed the chat settings (currently slow mode). Update the slow mode notice.

```json
{ "event": "chat.settings", "data": { "streamId": "d9b86c2e-2ddb-42d4-b204-5d0f18f067b5", "slowModeSeconds": 30 } }
```

### How clients should use it

1. Load the current state over REST (`GET /streams`, or `GET /streams/:idOrUsername` for one channel).
2. Open the WebSocket and apply events to that state.
3. For chat: load `GET /streams/:id/chat`, send `chat.join`, then append `chat.message` and remove `chat.deleted` (de-duplicate by `id`).
4. On reconnect, send `chat.join` again and reload: events sent while you were disconnected are **not** replayed.

### Several API instances

`stream.started`, `stream.ended`, `chat.message`, `chat.deleted` and `chat.settings` go through Redis pub/sub, so clients get them whichever instance they're connected to. Every instance runs its own viewer poll and sends `stream.viewers` to its own clients.

### Try it

```bash
# Node 22+ has a built-in WebSocket client
node -e 'const ws = new WebSocket("ws://localhost:8000/ws"); ws.onmessage = (m) => console.log(m.data)'
```

---

## MediaMTX integration

These endpoints are called by **MediaMTX** (tested with v1.21.3), not by apps.

- **No access token.** Instead, the caller's IP must match `WEBHOOK_ALLOWED_IPS` (addresses or CIDR masks); anything else gets `403 IP not allowed`.
- **Extra fields are ignored.** Only the fields listed below are read.
- **Response:** any 2xx means OK; anything else makes MediaMTX refuse the action.

The API uses the request's socket address. If the API runs behind a reverse proxy, that's the proxy's IP, unless Express's `trust proxy` is configured. With Docker Desktop, MediaMTX's requests arrive from `192.168.65.1`.

### POST /webhooks/mediamtx/auth

The `authHTTPAddress` hook. MediaMTX calls it before **every** publish and read.

- **`publish`:** allowed only if the path is `live/<stream settings id>` and the key matches that stream. The key is read from the query string (`?key=`). `?pass=` (password) and a Bearer token are also accepted, for WHIP/SRT clients.
- **`publish` to `watch/…` from loopback** (`ip` 127.0.0.1 or ::1): allowed without a key. This is MediaMTX's own transcoder republishing renditions (`watch/<streamId>/1080|720|480`). The same publish from any other IP is rejected.
- **`read` and `playback`:** always allowed, since watching is public.
- **Any other action** gets `403`. Exclude `api`, `metrics` and `pprof` from HTTP auth in MediaMTX.

**Request** (MediaMTX's own JSON format):

```http
POST /v1/webhooks/mediamtx/auth
Content-Type: application/json

{
  "user": "",
  "password": "",
  "token": "",
  "ip": "203.0.113.7",
  "action": "publish",
  "path": "live/8918071a-bcf3-4445-9a0e-f1b057c1d3ad",
  "protocol": "rtmp",
  "id": null,
  "query": "key=sk_X3ZOxjLmDS7rjswmX7MLhqAg4SK8y_yM"
}
```

**204 No Content:** allowed.

**Errors**

| Status | `message` | When |
|---|---|---|
| 401 | `Invalid stream key` | Unknown path, wrong key, or a key that has been replaced |
| 403 | `Action "api" is not allowed` | An action other than publish, read or playback |
| 403 | `IP not allowed` | Caller's IP isn't in `WEBHOOK_ALLOWED_IPS` |

### POST /webhooks/mediamtx/online

Called by the `runOnOnline` command once a broadcast is live. The API starts a live session for the stream's owner, with the stream's title. If the owner is already live (for example the encoder reconnected), the existing session continues.

```http
POST /v1/webhooks/mediamtx/online
Content-Type: application/x-www-form-urlencoded

path=live/8918071a-bcf3-4445-9a0e-f1b057c1d3ad
```

**204 No Content**

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `["path should not be empty", …]` | `path` missing |
| 404 | `Unknown stream path` | The path isn't `live/<stream settings id>` |
| 403 | `IP not allowed` | Caller's IP isn't in `WEBHOOK_ALLOWED_IPS` |

### POST /webhooks/mediamtx/offline

Called by the `runOnOffline` command when the broadcast stops. The API ends the owner's live session and saves it as a VOD. If they weren't live, nothing happens, so the call can be retried safely.

```http
POST /v1/webhooks/mediamtx/offline
Content-Type: application/x-www-form-urlencoded

path=live/8918071a-bcf3-4445-9a0e-f1b057c1d3ad
```

**204 No Content.** Errors are the same as [online](#post-webhooksmediamtxonline).

### MediaMTX setup

A ready-to-use config is in [`deploy/mediamtx/`](deploy/mediamtx/). The essentials:

```yaml
authMethod: http
authHTTPAddress: http://api:3000/v1/webhooks/mediamtx/auth
authHTTPExclude:
  - action: api
  - action: metrics
  - action: pprof

paths:
  "~^live/[0-9a-f-]{36}$":
    runOnOnline: curl -fsS -X POST http://api:3000/v1/webhooks/mediamtx/online -d path=$MTX_PATH
    runOnOffline: curl -fsS -X POST http://api:3000/v1/webhooks/mediamtx/offline -d path=$MTX_PATH
```

- Replace `http://api:3000/v1` with the API's address as seen from MediaMTX, and add MediaMTX's IP to `WEBHOOK_ALLOWED_IPS`.
- **The official `bluenviron/mediamtx` image has no shell and no `curl`**, so `runOnOnline`/`runOnOffline` fail in it. Use [`deploy/mediamtx/Dockerfile`](deploy/mediamtx/Dockerfile): the same binary on Alpine, with `curl` installed.
- MediaMTX 1.21 has no `runOnReady`/`runOnNotReady`; use `runOnOnline`/`runOnOffline` as shown.
- **Viewer counts need MediaMTX's API** (`api: yes`) and the API's `MEDIAMTX_API_URL` pointing at it. Keep it private: `authHTTPExclude` lets anyone reach it without auth.
- HLS players get a `302` to `…/index.m3u8?cookieCheck=1` first. That's MediaMTX's normal session redirect, and HLS players follow it.

---

## React web client

How to build the web app with React (Vite + TypeScript). The code here is **type-checked** (React 18, hls.js 1.5, @react-oauth/google 0.12). The API layer (`src/api/*`, including the WebSocket client) was **run against the real API**. That run covered session restore, single-flight refresh, expired-token retry, logout, revoked sessions, events, and reconnecting after a server restart. The UI components weren't run in a browser.

#### Rules for any client (web or mobile)

1. **Store both tokens after any `200` from `/auth/google`, `/auth/login`, `/auth/refresh` or `/auth/password`.** Every one of these returns a new refresh token, and the previous one stops working.
2. **Attach the access token** to every non-public request: `Authorization: Bearer <accessToken>`.
3. **On `401` from a protected endpoint**, call `/auth/refresh` once and retry the request with the new access token. If refresh fails, sign the user out locally.
4. **Refresh one request at a time.** Refresh tokens are single use, so two parallel refresh calls with the same token make one of them fail. Queue requests that fail with `401` while a refresh is in progress.
5. **On logout**, call `/auth/logout` with the refresh token, then delete both tokens locally, even if the call fails.
6. **Storage:** on mobile, use secure storage (Keychain or Keystore). On web, keep the access token in memory and the refresh token in the safest storage available.

### Setup

#### Packages

```bash
npm create vite@latest uztent-web -- --template react-ts
cd uztent-web
npm install @react-oauth/google hls.js
```

#### Environment (`.env.local` in the React app)

```bash
VITE_API_URL=http://localhost:8000/v1
VITE_GOOGLE_CLIENT_ID=<web-client-id>.apps.googleusercontent.com
VITE_WS_URL=ws://localhost:8000/ws
```

```ts
// src/vite-env.d.ts
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_GOOGLE_CLIENT_ID: string;
  readonly VITE_WS_URL: string;
}
```

#### What must match on the API and Google side

| Where | Setting | Value |
|---|---|---|
| API `.env` | `CORS_ORIGINS` | The React app's origin, e.g. `http://localhost:5173`. Separate several with commas. Without this, the browser blocks every request. |
| API `.env` | `GOOGLE_CLIENT_IDS` | Must include `VITE_GOOGLE_CLIENT_ID` |
| Google Cloud Console → Credentials → your **Web** OAuth client | Authorized JavaScript origins | The React app's origin, e.g. `http://localhost:5173` |

Keep the React dev server on Vite's default 5173, and don't run it on the API's port.

---

### API layer

Four files, with no HTTP library needed.

#### Types

```ts
// src/api/types.ts
export interface User {
  id: string;
  firstName: string;
  lastName: string;
  username: string | null;
  email: string;
  hasPassword: boolean;
  createdAt: string; // ISO 8601, UTC
  updatedAt: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

/** The user's stream settings (GET /streams/me). Contains secrets. */
export interface StreamSettings {
  id: string;
  title: string;
  /** Chat slow mode in seconds (0 = off) */
  chatSlowModeSeconds: number;
  streamKey: string;
  /** Paste into OBS "Stream Key": `<id>?key=<streamKey>` */
  encoderStreamKey: string;
  /** Paste into OBS "Server" */
  publishUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface Rendition {
  /** e.g. "1080p" */
  quality: string;
  /** HLS playlist URL */
  url: string;
}

export interface LiveStream {
  id: string;
  userId: string;
  title: string;
  startedAt: string;
  viewers: number;
  /** HLS playlist of the original broadcast */
  url: string;
  /** Transcoded qualities, highest first */
  renditions: Rendition[];
  /** Seconds viewers must wait between chat messages (0 = off) */
  chatSlowModeSeconds: number;
}

export interface Vod {
  id: string;
  userId: string;
  title: string;
  previewUri: string | null;
  videoUri: string | null;
  peakViewers: number;
  startedAt: string;
  endedAt: string;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface PageQuery {
  page?: number; // default 1
  limit?: number; // default 20, max 100
}

export interface ChatMessage {
  id: string;
  /** Live stream id (= VOD id after the stream ends) */
  streamId: string;
  userId: string;
  /** Username, or first name if the sender had none */
  senderName: string;
  /** Badge; null for viewers */
  senderRole: 'streamer' | 'moderator' | null;
  text: string;
  createdAt: string;
}

export interface ChatHistory {
  /** Oldest first */
  items: ChatMessage[];
  /** Older messages exist: pass `before = items[0].createdAt` */
  hasMore: boolean;
}

/** A banned user or a moderator of the caller's channel. */
export interface ChannelUser {
  userId: string;
  username: string | null;
  firstName: string;
  lastName: string;
  /** When they were banned / promoted */
  since: string;
}

export interface ChatPermissions {
  role: 'streamer' | 'moderator' | 'viewer';
  banned: boolean;
  /** 0 when off, or when the stream isn't live */
  slowModeSeconds: number;
  /** May delete messages, ban and unban */
  canModerate: boolean;
}
```

#### Token storage

- **Access token:** kept **in memory only**.
- **Refresh token:** in `localStorage`, so the session survives reloads and is shared between tabs.

```ts
// src/api/tokens.ts
import type { AuthResponse } from './types';

/**
 * Access token: memory only (gone on reload; restored with the refresh token).
 * Refresh token: localStorage, so the session survives reloads and is shared
 * across tabs.
 */
const REFRESH_KEY = 'uztent.refreshToken';

let accessToken: string | null = null;
const listeners = new Set<() => void>();

export const tokens = {
  getAccessToken: () => accessToken,

  getRefreshToken: (): string | null => {
    try {
      return localStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  },

  set({ accessToken: access, refreshToken }: Pick<AuthResponse, 'accessToken' | 'refreshToken'>) {
    accessToken = access;
    try {
      localStorage.setItem(REFRESH_KEY, refreshToken);
    } catch {
      /* storage unavailable: session lasts until reload */
    }
    listeners.forEach((fn) => fn());
  },

  clear() {
    accessToken = null;
    try {
      localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* ignore */
    }
    listeners.forEach((fn) => fn());
  },

  /** Called whenever tokens are set or cleared. Returns an unsubscribe function. */
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

// Another tab logged out (removed the refresh token): log out here too.
window.addEventListener('storage', (event) => {
  if (event.key === REFRESH_KEY && event.newValue === null) tokens.clear();
});
```

> **Security trade-off:** the API returns the refresh token in the response body, not as an httpOnly cookie, so a web client has to store it where JavaScript can read it. Any XSS bug can steal it. Keep a strict Content-Security-Policy and never render user content as HTML.

#### Fetch wrapper with automatic refresh

What the wrapper does:
- Adds `Authorization: Bearer …` to every request.
- On `401`, refreshes the tokens once and retries the request.
- After a page reload, gets a new access token before the first request.
- Turns error responses into `ApiError`.

**Refresh tokens are single use.** If two refreshes run at once, one of them fails and the user gets logged out. This wrapper prevents that:
- **within a tab**, concurrent callers share one refresh promise (this also covers React StrictMode's double effects);
- **across tabs**, it uses a Web Lock.

```ts
// src/api/client.ts
import { tokens } from './tokens';
import type { AuthResponse } from './types';

export const API_URL: string = import.meta.env.VITE_API_URL; // e.g. http://localhost:3000/v1

/** Every non-2xx response. `messages` is always an array (validation errors have several). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly messages: string[],
  ) {
    super(messages.join('\n') || `HTTP ${status}`);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Send the access token (default true). */
  auth?: boolean;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const auth = options.auth ?? true;

  // After a page reload only the refresh token exists: get an access token first.
  if (auth && !tokens.getAccessToken() && tokens.getRefreshToken()) {
    await refreshTokens();
  }

  let response = await send(path, options, auth);

  // Access token expired: refresh once and retry.
  if (response.status === 401 && auth && tokens.getRefreshToken()) {
    if (await refreshTokens()) response = await send(path, options, auth);
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function send(path: string, { method = 'GET', body, query, signal }: RequestOptions, auth: boolean) {
  const url = new URL(API_URL + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const accessToken = tokens.getAccessToken();
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  return fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const { message } = (await response.json()) as { message?: string | string[] };
    return new ApiError(response.status, Array.isArray(message) ? message : message ? [message] : []);
  } catch {
    return new ApiError(response.status, []);
  }
}

/**
 * Refresh tokens are single use, so only one refresh may run at a time:
 * - in this tab: concurrent callers share one promise;
 * - across tabs: a Web Lock, and the token is re-read inside the lock in case
 *   another tab already rotated it.
 */
let refreshing: Promise<boolean> | null = null;

export function refreshTokens(): Promise<boolean> {
  refreshing ??= (
    'locks' in navigator
      ? navigator.locks.request('uztent-token-refresh', doRefresh)
      : doRefresh()
  ).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = tokens.getRefreshToken();
  if (!refreshToken) return false;

  let response: Response;
  try {
    response = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    return false; // network error: keep the tokens, the user is still logged in
  }

  if (!response.ok) {
    // Session revoked or expired: log out (unless another tab just replaced the token).
    if (response.status === 401 && tokens.getRefreshToken() === refreshToken) tokens.clear();
    return false;
  }

  tokens.set((await response.json()) as AuthResponse);
  return true;
}
```

#### Endpoint functions

```ts
// src/api/endpoints.ts
import { api, ApiError } from './client';
import { tokens } from './tokens';
import type {
  AuthResponse,
  ChannelUser,
  ChatHistory,
  ChatPermissions,
  ChatMessage,
  LiveStream,
  PageQuery,
  Paginated,
  StreamSettings,
  User,
  Vod,
} from './types';

// ---- Auth ----------------------------------------------------------------

/** `idToken` = `credential` from Google Sign-In. Stores the new tokens. */
export async function loginWithGoogle(idToken: string): Promise<AuthResponse> {
  const result = await api<AuthResponse>('/auth/google', {
    method: 'POST',
    body: { idToken },
    auth: false,
  });
  tokens.set(result);
  return result;
}

/** `login` = email or username. Only works after the user has set a password. */
export async function loginWithPassword(login: string, password: string): Promise<AuthResponse> {
  const result = await api<AuthResponse>('/auth/login', {
    method: 'POST',
    body: { login, password },
    auth: false,
  });
  tokens.set(result);
  return result;
}

/** Ends this device's session. Always clears local tokens, even if the call fails. */
export async function logout(): Promise<void> {
  const refreshToken = tokens.getRefreshToken();
  try {
    if (refreshToken) {
      await api<void>('/auth/logout', { method: 'POST', body: { refreshToken }, auth: false });
    }
  } finally {
    tokens.clear();
  }
}

/**
 * Sets the first password (omit `currentPassword`) or changes it.
 * Signs out every other device; this one gets new tokens.
 */
export async function setPassword(newPassword: string, currentPassword?: string): Promise<AuthResponse> {
  const result = await api<AuthResponse>('/auth/password', {
    method: 'POST',
    body: currentPassword ? { newPassword, currentPassword } : { newPassword },
  });
  tokens.set(result);
  return result;
}

// ---- Users ---------------------------------------------------------------

export const getMe = () => api<User>('/users/me');

/** Send only changed fields. `username: null` removes the username. */
export const updateMe = (
  changes: Partial<Pick<User, 'firstName' | 'lastName'>> & { username?: string | null },
) => api<User>('/users/me', { method: 'PATCH', body: changes });

export const checkUsername = (username: string, signal?: AbortSignal) =>
  api<{ username: string; available: boolean }>('/users/username-availability', {
    query: { username },
    signal,
  });

// ---- Stream settings (stream key) ------------------------------------------

/** `null` if the user hasn't generated a stream key yet. */
export async function getMyStream(): Promise<StreamSettings | null> {
  try {
    return await api<StreamSettings>('/streams/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Send only what changes. Applies to the current live stream too (slow mode is pushed as chat.settings). */
export const updateStream = (changes: { title?: string; chatSlowModeSeconds?: number }) =>
  api<StreamSettings>('/streams/me', { method: 'PATCH', body: changes });

export const updateStreamTitle = (title: string) => updateStream({ title });

/** Creates the key, or replaces it (the old key stops working for new broadcasts). */
export const generateStreamKey = () =>
  api<StreamSettings>('/streams/me/key', { method: 'POST' });

// ---- Live streams -----------------------------------------------------------

/** Public. Newest first. Use with WebSocket events to keep it current (see useLiveStreams). */
export const listLiveStreams = (query: PageQuery = {}) =>
  api<Paginated<LiveStream>>('/streams', { query: { ...query }, auth: false });

export type ChannelLiveStatus =
  | { status: 'live'; stream: LiveStream }
  | { status: 'offline' }
  | { status: 'not-found' };

/** Public (no login needed): for a channel page like /@aziz_k. Username is case-insensitive. */
export async function getLiveStreamByUsername(username: string): Promise<ChannelLiveStatus> {
  try {
    const stream = await api<LiveStream>(
      `/streams/${encodeURIComponent(username)}`,
      { auth: false },
    );
    return { status: 'live', stream };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return error.message === 'User is not live' ? { status: 'offline' } : { status: 'not-found' };
    }
    throw error;
  }
}

/** Public. Throws ApiError 404 once the stream has ended (look for a VOD with the same id). */
export const getLiveStream = (id: string) =>
  api<LiveStream>(`/streams/${id}`, { auth: false });

// ---- VODs ----------------------------------------------------------------

export const listMyVods = (query: PageQuery = {}) =>
  api<Paginated<Vod>>('/vods/me', { query: { ...query } });

export const listUserVods = (userId: string, query: PageQuery = {}) =>
  api<Paginated<Vod>>(`/users/${userId}/vods`, { query: { ...query } });

export const getVod = (id: string) => api<Vod>(`/vods/${id}`);

export const deleteVod = (id: string) => api<void>(`/vods/${id}`, { method: 'DELETE' });

// ---- Chat -------------------------------------------------------------------

/** Public. Newest `limit` messages (oldest first), or older ones with `before`. Works for VODs too. */
export const getChatHistory = (streamId: string, query: { before?: string; limit?: number } = {}) =>
  api<ChatHistory>(`/streams/${streamId}/chat`, { query: { ...query }, auth: false });

/** What the logged-in user may do in this chat (role, banned, slow mode). */
export const getChatPermissions = (streamId: string) =>
  api<ChatPermissions>(`/streams/${streamId}/chat/me`);

/** Only while the stream is live. 429 = rate limit or slow mode (message says how long), 403 = banned. */
export const sendChatMessage = (streamId: string, text: string) =>
  api<ChatMessage>(`/streams/${streamId}/chat`, { method: 'POST', body: { text } });

/** Streamer or moderator (live chat and VOD replay). */
export const deleteChatMessage = (streamId: string, messageId: string) =>
  api<void>(`/streams/${streamId}/chat/${messageId}`, { method: 'DELETE' });

/** Streamer or moderator, from inside a stream: bans from all of the streamer's chats. */
export const banInChat = (streamId: string, userId: string) =>
  api<void>(`/streams/${streamId}/chat/bans`, { method: 'POST', body: { userId } });

export const unbanInChat = (streamId: string, userId: string) =>
  api<void>(`/streams/${streamId}/chat/bans/${userId}`, { method: 'DELETE' });

// Streamer's own channel settings

export const listChatBans = () => api<ChannelUser[]>('/streams/me/bans');

/** Banning one of your moderators also removes the role. */
export const banFromChat = (userId: string) =>
  api<void>('/streams/me/bans', { method: 'POST', body: { userId } });

export const unbanFromChat = (userId: string) =>
  api<void>(`/streams/me/bans/${userId}`, { method: 'DELETE' });

export const listModerators = () => api<ChannelUser[]>('/streams/me/moderators');

/** Promoting a banned user lifts the ban. */
export const addModerator = (userId: string) =>
  api<void>('/streams/me/moderators', { method: 'POST', body: { userId } });

export const removeModerator = (userId: string) =>
  api<void>(`/streams/me/moderators/${userId}`, { method: 'DELETE' });
```

---

### Sign-in and sessions

Users are created **only through Google**. A user who has set a password can also log in with email or username plus password.

#### Auth context

```tsx
// src/auth/AuthProvider.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getMe, logout } from '../api/endpoints';
import { tokens } from '../api/tokens';
import type { User } from '../api/types';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** Call with the `user` from any login response, or after updating the profile. */
  setUser: (user: User) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>(
    tokens.getRefreshToken() ? 'loading' : 'anonymous',
  );

  // Restore the session after a reload.
  useEffect(() => {
    if (!tokens.getRefreshToken()) return;
    getMe()
      .then((me) => {
        setUserState(me);
        setStatus('authenticated');
      })
      .catch(() => setStatus('anonymous'));
  }, []);

  // Tokens cleared anywhere (failed refresh, logout in another tab): log out.
  useEffect(
    () =>
      tokens.subscribe(() => {
        if (!tokens.getRefreshToken()) {
          setUserState(null);
          setStatus('anonymous');
        }
      }),
    [],
  );

  const value: AuthContextValue = {
    status,
    user,
    setUser: (next) => {
      setUserState(next);
      setStatus('authenticated');
    },
    signOut: () => logout(),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
```

#### App entry

```tsx
// src/main.tsx
import { GoogleOAuthProvider } from '@react-oauth/google';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './auth/AuthProvider';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </GoogleOAuthProvider>
  </StrictMode>,
);
```

#### Google button

`@react-oauth/google`'s `<GoogleLogin>` returns a `credential`, which is the **ID token** the API expects.

> **Don't use `useGoogleLogin()`.** It returns a Google *access token*, and the API will answer `401 Invalid Google token`.

```tsx
// src/components/GoogleSignInButton.tsx
import { GoogleLogin } from '@react-oauth/google';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { loginWithGoogle } from '../api/endpoints';
import { useAuth } from '../auth/AuthProvider';

export function GoogleSignInButton() {
  const { setUser } = useAuth();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <GoogleLogin
        onSuccess={async ({ credential }) => {
          if (!credential) return setError('Google did not return a token');
          try {
            const { user } = await loginWithGoogle(credential);
            setUser(user);
            // New user: user.username === null -> ask them to pick one.
          } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Sign-in failed');
          }
        }}
        onError={() => setError('Google sign-in was cancelled or failed')}
      />
      {error && <p role="alert">{error}</p>}
    </>
  );
}
```

#### Session behaviour the UI should handle

| Situation | What happens | UI |
|---|---|---|
| Page reload | `AuthProvider` calls `getMe()`, and the wrapper refreshes first | Show nothing (or a spinner) while `status === 'loading'` |
| Access token expires (every 15 min by default) | Refreshed automatically | Nothing |
| Session revoked or expired (30 days), or the password was changed on another device | The refresh fails with 401, and tokens are cleared | `status` becomes `anonymous`: show sign-in |
| Logout in another tab | A `storage` event clears tokens here too | Same as above |
| User sets or changes their password | `setPassword()` stores the new tokens; **other devices** are signed out | Show "Password saved" |

#### Password login form (optional)

```tsx
const { setUser } = useAuth();
const onSubmit = async (login: string, password: string) => {
  try {
    const { user } = await loginWithPassword(login, password); // login = email or username
    setUser(user);
  } catch (e) {
    // 401 "Invalid credentials" also covers "this user has no password yet".
    setError(e instanceof ApiError ? e.message : 'Login failed');
  }
};
```

#### Set or change password

Check `user.hasPassword` to decide which form to show:

```tsx
// first password: no currentPassword
const { user } = await setPassword(newPassword);
// change: currentPassword required, otherwise 400 "currentPassword is required"
const { user } = await setPassword(newPassword, currentPassword);
setUser(user); // user.hasPassword is now true
```

Password rules: 8–128 characters.

---

### Profile and username

```tsx
const { user, setUser } = useAuth();

// send only changed fields: unknown or extra fields get 400 "property x should not exist"
setUser(await updateMe({ firstName: 'Aziz', username: 'aziz_k' }));
setUser(await updateMe({ username: null })); // remove username
```

- **`firstName`:** 1–100 characters, can't be empty or `null`.
- **`lastName`:** 0–100 characters (`""` allowed, `null` isn't).
- **`username`:** 3–30 characters of `a-z 0-9 _ .`. The API trims and lowercases it.
- **`email`** can't be changed.

**New users have `username: null`.** After the first Google sign-in, send them to a "pick a username" screen.

#### Live username check (debounced)

```ts
// src/hooks/useUsernameAvailability.ts
import { useEffect, useState } from 'react';
import { checkUsername } from '../api/endpoints';

/** Same rule as the API, after trimming and lowercasing. */
export const USERNAME_PATTERN = /^[a-z0-9_.]{3,30}$/;

type Availability =
  | { state: 'idle' | 'checking' | 'invalid' | 'error' }
  | { state: 'available' | 'taken'; username: string };

export function useUsernameAvailability(input: string, delayMs = 300): Availability {
  const [result, setResult] = useState<Availability>({ state: 'idle' });

  useEffect(() => {
    const username = input.trim().toLowerCase();
    if (!username) return setResult({ state: 'idle' });
    if (!USERNAME_PATTERN.test(username)) return setResult({ state: 'invalid' });

    setResult({ state: 'checking' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkUsername(username, controller.signal)
        .then(({ username: checked, available }) =>
          setResult({ state: available ? 'available' : 'taken', username: checked }),
        )
        .catch(() => {
          if (!controller.signal.aborted) setResult({ state: 'error' });
        });
    }, delayMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, delayMs]);

  return result;
}
```

```tsx
const [input, setInput] = useState('');
const availability = useUsernameAvailability(input);
// availability.state: 'idle' | 'checking' | 'invalid' | 'available' | 'taken' | 'error'
// availability.username (when available/taken) is the normalized value that will be saved
```

The check is only a hint. On save, still handle `409 Username is already taken` from `updateMe`.

---

### Stream settings (OBS setup)

Each user has one stream configuration, which holds their **title** and **stream key**. Until the user generates a key, `getMyStream()` returns `null`.

```tsx
// src/components/StreamSettingsPanel.tsx
import { useEffect, useState } from 'react';
import { generateStreamKey, getMyStream, updateStream, updateStreamTitle } from '../api/endpoints';
import type { StreamSettings } from '../api/types';

export function StreamSettingsPanel() {
  const [settings, setSettings] = useState<StreamSettings | null | undefined>(undefined);
  const [showKey, setShowKey] = useState(false);
  const [title, setTitle] = useState('');

  useEffect(() => {
    getMyStream().then((s) => {
      setSettings(s);
      setTitle(s?.title ?? '');
    });
  }, []);

  if (settings === undefined) return <p>Loading…</p>;

  if (settings === null) {
    return (
      <button onClick={async () => setSettings(await generateStreamKey())}>
        Generate stream key
      </button>
    );
  }

  const regenerate = async () => {
    if (!confirm('Replace your stream key? You will need to paste the new one into OBS.')) return;
    setSettings(await generateStreamKey());
    setShowKey(false);
  };

  return (
    <section>
      <label>
        Title
        <input value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <button
        disabled={!title.trim() || title === settings.title}
        onClick={async () => setSettings(await updateStreamTitle(title.trim()))}
      >
        Save title
      </button>

      <label>
        Chat slow mode
        <select
          value={settings.chatSlowModeSeconds}
          onChange={async (e) =>
            setSettings(await updateStream({ chatSlowModeSeconds: Number(e.target.value) }))
          }
        >
          {[0, 3, 10, 30, 60, 120, 300].map((s) => (
            <option key={s} value={s}>
              {s === 0 ? 'Off' : `${s} s`}
            </option>
          ))}
        </select>
      </label>

      <h3>OBS → Settings → Stream → Service: Custom</h3>
      <p>
        Server: <code>{settings.publishUrl}</code>{' '}
        <button onClick={() => navigator.clipboard.writeText(settings.publishUrl)}>Copy</button>
      </p>
      <p>
        Stream Key: <code>{showKey ? settings.encoderStreamKey : '••••••••••••'}</code>{' '}
        <button onClick={() => setShowKey((v) => !v)}>{showKey ? 'Hide' : 'Show'}</button>{' '}
        <button onClick={() => navigator.clipboard.writeText(settings.encoderStreamKey)}>Copy</button>
      </p>
      <button onClick={regenerate}>Generate new key</button>
    </section>
  );
}
```

- **`encoderStreamKey` is a secret.** Mask it by default and never log it or put it in URLs. `publishUrl` isn't secret.
- **Replacing the key** affects new broadcasts straight away. A broadcast that's already running continues. Tell users to paste the new key into OBS.
- **Changing the title while live** renames the current broadcast too.
- **There's no "Go live" button.** Going live happens when the user clicks **Start Streaming** in OBS; the media server tells the API. The web app only shows the settings.

---

### Live streams and playback

#### Real-time events (WebSocket)

One shared connection for the whole app. It reconnects with backoff and tells subscribers when to reload state they may have missed.

```ts
// src/api/events.ts
import type { ChatMessage, LiveStream } from './types';

/** Server → client messages on the WebSocket. */
export type ServerEvent =
  | { event: 'stream.started'; data: LiveStream }
  | { event: 'stream.ended'; data: { id: string; userId: string; vodId: string } }
  | { event: 'stream.viewers'; data: { id: string; viewers: number }[] }
  // Only for chats this client joined (joinChat):
  | { event: 'chat.message'; data: ChatMessage }
  | { event: 'chat.deleted'; data: { id: string; streamId: string } }
  | { event: 'chat.settings'; data: { streamId: string; slowModeSeconds: number } }
  // Replies to chat.join / chat.leave:
  | { event: 'chat.joined' | 'chat.left'; data: { streamId: string } }
  | { event: 'error'; data: { message: string } };

export const WS_URL: string = import.meta.env.VITE_WS_URL; // e.g. ws://localhost:8000/ws

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
const reconnectListeners = new Set<() => void>();
let socket: WebSocket | null = null;
let retries = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
/** streamId -> number of components in that chat */
const joinedChats = new Map<string, number>();

function sendToServer(event: string, data: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, data }));
}

/**
 * One shared connection for the whole app: opened with the first subscriber,
 * closed with the last, reconnected with backoff (1 s … 30 s) if it drops.
 */
function connect() {
  reconnectTimer = undefined;
  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.onopen = () => {
    // Joins are per connection: (re)join every chat in use.
    for (const streamId of joinedChats.keys()) sendToServer('chat.join', { streamId });
    // Events may have been missed while disconnected: let subscribers reload.
    if (retries > 0) reconnectListeners.forEach((fn) => fn());
    retries = 0;
  };
  ws.onmessage = (message) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(String(message.data)) as ServerEvent;
    } catch {
      return;
    }
    listeners.forEach((fn) => fn(event));
  };
  ws.onclose = () => {
    if (socket !== ws) return; // replaced or closed on purpose
    socket = null;
    if (listeners.size === 0) return;
    const delay = Math.min(30_000, 1000 * 2 ** retries++);
    reconnectTimer = setTimeout(connect, delay);
  };
}

/** Returns an unsubscribe function. `onReconnect` runs after a dropped connection is restored. */
export function subscribeEvents(listener: Listener, onReconnect?: () => void): () => void {
  listeners.add(listener);
  if (onReconnect) reconnectListeners.add(onReconnect);
  if (!socket && !reconnectTimer) connect();

  return () => {
    listeners.delete(listener);
    if (onReconnect) reconnectListeners.delete(onReconnect);
    if (listeners.size === 0) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const ws = socket;
      socket = null;
      ws?.close();
      retries = 0;
    }
  };
}

/**
 * Receive chat.message / chat.deleted for one stream. Returns a leave function.
 * Needs an active subscription (useServerEvents) to keep the socket open.
 */
export function joinChat(streamId: string): () => void {
  const count = joinedChats.get(streamId) ?? 0;
  joinedChats.set(streamId, count + 1);
  if (count === 0) sendToServer('chat.join', { streamId });

  return () => {
    const left = (joinedChats.get(streamId) ?? 1) - 1;
    if (left > 0) return void joinedChats.set(streamId, left);
    joinedChats.delete(streamId);
    sendToServer('chat.leave', { streamId });
  };
}
```

```ts
// src/hooks/useServerEvents.ts
import { useEffect, useRef } from 'react';
import { subscribeEvents, type ServerEvent } from '../api/events';

/** Subscribes for the component's lifetime. Handlers can change between renders. */
export function useServerEvents(onEvent: (event: ServerEvent) => void, onReconnect?: () => void) {
  const eventRef = useRef(onEvent);
  const reconnectRef = useRef(onReconnect);
  useEffect(() => {
    eventRef.current = onEvent;
    reconnectRef.current = onReconnect;
  });

  useEffect(
    () =>
      subscribeEvents(
        (event) => eventRef.current(event),
        () => reconnectRef.current?.(),
      ),
    [],
  );
}
```

#### Live list

```ts
// src/hooks/useLiveStreams.ts
import { useCallback, useEffect, useState } from 'react';
import { listLiveStreams } from '../api/endpoints';
import type { LiveStream } from '../api/types';
import { useServerEvents } from './useServerEvents';

/** Live streams, newest first: loaded once, then kept current by WebSocket events. */
export function useLiveStreams() {
  const [streams, setStreams] = useState<LiveStream[]>([]);

  const load = useCallback(() => {
    listLiveStreams({ limit: 100 })
      .then(({ items }) => setStreams(items))
      .catch(() => {
        /* keep the last list */
      });
  }, []);

  useEffect(load, [load]);

  useServerEvents((e) => {
    switch (e.event) {
      case 'stream.started':
        setStreams((list) => [e.data, ...list.filter((s) => s.id !== e.data.id)]);
        break;
      case 'stream.ended':
        setStreams((list) => list.filter((s) => s.id !== e.data.id));
        break;
      case 'stream.viewers': {
        const counts = new Map(e.data.map((s) => [s.id, s.viewers]));
        setStreams((list) =>
          list.map((s) => (counts.has(s.id) ? { ...s, viewers: counts.get(s.id)! } : s)),
        );
        break;
      }
    }
  }, load);

  return streams;
}
```

#### HLS player

`stream.url` is an HLS playlist (`…/index.m3u8`). Chrome, Firefox and Edge need **hls.js**; Safari and iOS play it natively.

```tsx
// src/components/HlsPlayer.tsx
import Hls from 'hls.js';
import { useEffect, useRef } from 'react';

/** Plays an HLS (.m3u8) URL: hls.js where supported, native HLS on Safari/iOS. */
export function HlsPlayer({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      return () => {
        video.removeAttribute('src');
        video.load();
      };
    }
  }, [src]);

  return <video ref={videoRef} controls autoPlay muted playsInline style={{ width: '100%' }} />;
}
```

#### Quality picker

Each live stream has its original broadcast (`url`) and transcoded `renditions` (1080p, 720p, 480p).

```tsx
// src/components/LivePlayer.tsx
import { useState } from 'react';
import type { LiveStream } from '../api/types';
import { HlsPlayer } from './HlsPlayer';

/** Player with a quality picker. "Source" plays the original broadcast. */
export function LivePlayer({ stream }: { stream: LiveStream }) {
  const options = [
    { quality: 'Source', url: stream.url },
    ...stream.renditions,
  ];
  // Default to 720p if available: a good balance for most connections.
  const [url, setUrl] = useState(
    stream.renditions.find((r) => r.quality === '720p')?.url ?? stream.url,
  );

  return (
    <div>
      <HlsPlayer src={url} />
      <select value={url} onChange={(e) => setUrl(e.target.value)}>
        {options.map((o) => (
          <option key={o.url} value={o.url}>
            {o.quality}
          </option>
        ))}
      </select>
    </div>
  );
}
```

```tsx
const streams = useLiveStreams();
return streams.map((s) => (
  <article key={s.id}>
    <h3>{s.title}</h3>
    <LivePlayer stream={s} />
  </article>
));
```

Each quality is a separate stream on the media server, so hls.js can't switch quality automatically (no ABR). Switching reloads the player. Default to 720p and let users pick.

#### Channel page (public)

`getLiveStreamByUsername()` needs no login, so logged-out visitors can open a channel page. It returns `live`, `offline` or `not-found`. WebSocket events switch the page between live and offline and update the viewer count.

```tsx
// src/components/ChannelPage.tsx
import { useCallback, useEffect, useState } from 'react';
import { getLiveStreamByUsername, type ChannelLiveStatus } from '../api/endpoints';
import { useServerEvents } from '../hooks/useServerEvents';
import { LivePlayer } from './LivePlayer';

/** Works for logged-out visitors. Goes live/offline and updates viewers via WebSocket events. */
export function ChannelPage({ username }: { username: string }) {
  const [channel, setChannel] = useState<ChannelLiveStatus | null>(null);

  const load = useCallback(() => {
    getLiveStreamByUsername(username)
      .then(setChannel)
      .catch(() => {
        /* keep the last state on network errors */
      });
  }, [username]);

  useEffect(load, [load]);

  useServerEvents((e) => {
    const live = channel?.status === 'live' ? channel.stream : null;
    if (e.event === 'stream.viewers' && live) {
      const update = e.data.find((s) => s.id === live.id);
      if (update) setChannel({ status: 'live', stream: { ...live, viewers: update.viewers } });
    } else if (e.event === 'stream.ended' && live?.id === e.data.id) {
      setChannel({ status: 'offline' });
    } else if (e.event === 'stream.started' && channel?.status === 'offline') {
      // Events carry userId, not username: re-check this channel.
      load();
    }
  }, load);

  if (!channel) return <p>Loading…</p>;
  if (channel.status === 'not-found') return <p>No user @{username}</p>;
  if (channel.status === 'offline') return <p>@{username} is offline</p>;
  return (
    <article>
      <h2>{channel.stream.title}</h2>
      <p>{channel.stream.viewers} watching</p>
      <LivePlayer key={channel.stream.id} stream={channel.stream} />
    </article>
  );
}
```

`key={channel.stream.id}` remounts the player when a new broadcast starts.

Playback notes:
- **Same URLs every broadcast.** A user's `url` and rendition URLs don't change between broadcasts. When they're offline the media server returns 404, so only render the player for streams that are live (in `listLiveStreams()` or announced by `stream.started`).
- **Autoplay** only works muted (`muted` is set), so let the user unmute.
- **Redirect:** the media server first answers with a `302` to `…?cookieCheck=1`. hls.js follows it automatically.
- **Not yet tested in a browser:** playback has been verified with ffprobe, not with hls.js. If segments fail to load cross-origin, check MediaMTX's `hlsAllowOrigin` (default `*`).
- **When a stream ends**, `getLiveStream(id)` returns `404`. A VOD with the **same `id`** appears in the streamer's VODs.
- **`viewers`** arrives every 5 s through `stream.viewers`; no polling needed. Viewers who leave are dropped about 40 s later.

---

### Chat panel

`joinChat()` in `src/api/events.ts` (above) keeps a count of the components using each chat. It sends `chat.join` when the first component joins and `chat.leave` when the last one leaves, and rejoins every chat after a reconnect.

```ts
// src/hooks/useChat.ts
import { useCallback, useEffect, useState } from 'react';
import { joinChat } from '../api/events';
import { getChatHistory, getChatPermissions, sendChatMessage } from '../api/endpoints';
import type { ChatMessage, ChatPermissions } from '../api/types';
import { useServerEvents } from './useServerEvents';

const MAX_MESSAGES = 500; // keep memory bounded in long streams

function addUnique(list: ChatMessage[], message: ChatMessage) {
  return list.some((m) => m.id === message.id) ? list : [...list, message].slice(-MAX_MESSAGES);
}

/**
 * Chat of one live stream (or VOD replay): history, live messages, deletions,
 * slow mode, and the logged-in user's permissions.
 */
export function useChat(streamId: string, { loggedIn }: { loggedIn: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [permissions, setPermissions] = useState<ChatPermissions | null>(null);
  const [slowModeSeconds, setSlowModeSeconds] = useState(0);

  const load = useCallback(() => {
    getChatHistory(streamId)
      .then((history) => {
        setMessages(history.items);
        setHasMore(history.hasMore);
      })
      .catch(() => {
        /* keep what we have */
      });
  }, [streamId]);

  const loadPermissions = useCallback(() => {
    if (!loggedIn) return setPermissions(null);
    getChatPermissions(streamId)
      .then((p) => {
        setPermissions(p);
        setSlowModeSeconds(p.slowModeSeconds);
      })
      .catch(() => setPermissions(null));
  }, [streamId, loggedIn]);

  useEffect(() => {
    setMessages([]);
    load();
    return joinChat(streamId);
  }, [streamId, load]);

  useEffect(loadPermissions, [loadPermissions]);

  useServerEvents(
    (e) => {
      if (e.event === 'chat.message' && e.data.streamId === streamId) {
        setMessages((list) => addUnique(list, e.data));
      } else if (e.event === 'chat.deleted' && e.data.streamId === streamId) {
        setMessages((list) => list.filter((m) => m.id !== e.data.id));
      } else if (e.event === 'chat.settings' && e.data.streamId === streamId) {
        setSlowModeSeconds(e.data.slowModeSeconds);
      }
    },
    () => {
      load();
      loadPermissions();
    },
  );

  const loadOlder = useCallback(async () => {
    const oldest = messages[0];
    if (!oldest) return;
    const history = await getChatHistory(streamId, { before: oldest.createdAt });
    setMessages((list) => [...history.items, ...list]);
    setHasMore(history.hasMore);
  }, [messages, streamId]);

  /** Shows the message immediately; the WebSocket copy is de-duplicated by id. */
  const send = useCallback(
    async (text: string) => {
      const message = await sendChatMessage(streamId, text);
      setMessages((list) => addUnique(list, message));
    },
    [streamId],
  );

  return {
    messages,
    hasMore,
    loadOlder,
    send,
    permissions,
    /** Refresh after you were banned/unbanned or promoted. */
    reloadPermissions: loadPermissions,
    /** Applies to viewers only; the streamer and moderators are exempt. */
    slowModeSeconds,
  };
}
```

```tsx
// src/components/ChatPanel.tsx
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { banInChat, deleteChatMessage } from '../api/endpoints';
import type { ChatMessage, LiveStream } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { useChat } from '../hooks/useChat';

const BADGES = { streamer: '🎥', moderator: '🛡️' } as const;

/**
 * Chat next to the player. Anyone can read; logged-in users can write;
 * the streamer and moderators can delete messages and ban viewers.
 */
export function ChatPanel({ stream }: { stream: LiveStream }) {
  const { user } = useAuth();
  const chat = useChat(stream.id, { loggedIn: !!user });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canModerate = chat.permissions?.canModerate ?? false;
  const isViewer = chat.permissions?.role === 'viewer';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await chat.send(text);
      setText('');
      setError(null);
    } catch (err) {
      // 429 "You are sending messages too fast" / "Slow mode is on: wait N s …",
      // 403 "You are banned from this chat", 404 "Stream not found" (ended)
      setError(err instanceof ApiError ? err.message : 'Message not sent');
      if (err instanceof ApiError && err.status === 403) chat.reloadPermissions();
    }
  };

  // Moderators can't act on the streamer; only the streamer can act on moderators.
  const canActOn = (m: ChatMessage) =>
    canModerate &&
    m.userId !== user?.id &&
    m.senderRole !== 'streamer' &&
    (m.senderRole !== 'moderator' || chat.permissions?.role === 'streamer');

  const act = (action: () => Promise<void>) =>
    action().catch((err) => setError(err instanceof ApiError ? err.message : 'Action failed'));

  return (
    <aside>
      {chat.slowModeSeconds > 0 && (
        <p>
          Slow mode: one message every {chat.slowModeSeconds} s
          {!isViewer && ' (you are exempt)'}
        </p>
      )}
      {chat.hasMore && <button onClick={chat.loadOlder}>Load older</button>}
      <ul>
        {chat.messages.map((m) => (
          <li key={m.id}>
            {m.senderRole && <span title={m.senderRole}>{BADGES[m.senderRole]} </span>}
            <strong>{m.senderName}</strong> {m.text}
            {canActOn(m) && (
              <>
                <button onClick={() => act(() => deleteChatMessage(stream.id, m.id))}>
                  Delete
                </button>
                <button onClick={() => act(() => banInChat(stream.id, m.userId))}>Ban</button>
              </>
            )}
          </li>
        ))}
      </ul>
      {!user ? (
        <p>Sign in to chat</p>
      ) : chat.permissions?.banned ? (
        <p>You are banned from this chat</p>
      ) : (
        <form onSubmit={submit}>
          <input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
          <button disabled={!text.trim()}>Send</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </aside>
  );
}
```

Usage next to the player:

```tsx
<LivePlayer stream={stream} />
<ChatPanel stream={stream} />
```

#### Moderators and bans (streamer settings)

Slow mode lives in `StreamSettingsPanel` (above, a select calling `updateStream({ chatSlowModeSeconds })`). Moderators and bans:

```tsx
// src/components/ChatModeratorsPanel.tsx
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import {
  addModerator,
  listChatBans,
  listModerators,
  removeModerator,
  unbanFromChat,
} from '../api/endpoints';
import type { ChannelUser } from '../api/types';

const name = (u: ChannelUser) => u.username ?? `${u.firstName} ${u.lastName}`.trim();

/**
 * Streamer settings: moderators and bans. Promote users by id, e.g. from a
 * chat message's `userId`.
 */
export function ChatModeratorsPanel() {
  const [moderators, setModerators] = useState<ChannelUser[]>([]);
  const [bans, setBans] = useState<ChannelUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([listModerators(), listChatBans()])
      .then(([mods, banned]) => {
        setModerators(mods);
        setBans(banned);
      })
      .catch(() => setError('Could not load chat settings'));
  }, []);

  useEffect(reload, [reload]);

  const run = (action: () => Promise<void>) =>
    action()
      .then(reload)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Action failed'));

  return (
    <section>
      <h3>Moderators</h3>
      <ul>
        {moderators.map((m) => (
          <li key={m.userId}>
            {name(m)} <button onClick={() => run(() => removeModerator(m.userId))}>Remove</button>
          </li>
        ))}
      </ul>
      <h3>Banned</h3>
      <ul>
        {bans.map((b) => (
          <li key={b.userId}>
            {name(b)} <button onClick={() => run(() => unbanFromChat(b.userId))}>Unban</button>{' '}
            <button onClick={() => run(() => addModerator(b.userId))}>Make moderator</button>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** Use from a chat message's menu: promote the sender. */
export const promoteToModerator = (userId: string) => addModerator(userId);
```

- **De-duplication:** the sender's own message arrives twice, from the POST response and over the WebSocket. `useChat` adds messages by `id`, so it shows once.
- **Controls:** `useChat` loads `getChatPermissions()` for logged-in users. Show Delete/Ban when `canModerate` is true, and hide them on the streamer's messages (and on moderators' messages for moderators). The API enforces the same rules.
- **Badges:** `senderRole` is `streamer`, `moderator` or `null`.
- **Slow mode:** `useChat().slowModeSeconds` starts from the permissions call and follows `chat.settings`. It applies to viewers only.
- **Ban:** use the message's `userId` with `banInChat(streamId, userId)`. Bans apply to all of the streamer's streams.
- **VOD replay:** `useChat(vod.id)` shows the stored chat. Sending fails with 404, so hide the input for VODs.

### VOD list

```tsx
// src/components/VodList.tsx
import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { deleteVod, listMyVods } from '../api/endpoints';
import type { Paginated, Vod } from '../api/types';

export function MyVods() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<Vod> | null>(null);

  useEffect(() => {
    listMyVods({ page, limit: 20 }).then(setData);
  }, [page]);

  if (!data) return <p>Loading…</p>;
  const pages = Math.max(1, Math.ceil(data.total / data.limit));

  const remove = async (id: string) => {
    try {
      await deleteVod(id);
      setData({ ...data, items: data.items.filter((v) => v.id !== id), total: data.total - 1 });
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Delete failed');
    }
  };

  return (
    <>
      <ul>
        {data.items.map((vod) => (
          <li key={vod.id}>
            {vod.previewUri ? <img src={vod.previewUri} alt="" width={160} /> : null}
            <strong>{vod.title}</strong> · {new Date(vod.startedAt).toLocaleString()} · peak{' '}
            {vod.peakViewers}
            {vod.videoUri ? null : <em> (processing)</em>}
            <button onClick={() => remove(vod.id)}>Delete</button>
          </li>
        ))}
      </ul>
      <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
      {page} / {pages}
      <button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
    </>
  );
}
```

- **`videoUri` and `previewUri` are `null`** until the recording is processed, and nothing fills them in yet. Show "processing" and no player.
- **Another user's VODs:** use `listUserVods(userId)`. Deleting a VOD you don't own returns `403`.
- **Lists are paginated:** `page` starts at 1 and `limit` is at most 100. Work out the number of pages from `total / limit`.

---

### Endpoint → function reference

| Function | Endpoint | Notes |
|---|---|---|
| `loginWithGoogle(idToken)` | `POST /auth/google` | Stores tokens |
| `loginWithPassword(login, password)` | `POST /auth/login` | Stores tokens |
| `refreshTokens()` | `POST /auth/refresh` | Called by the wrapper; you rarely need it directly |
| `logout()` | `POST /auth/logout` | Always clears local tokens |
| `setPassword(new, current?)` | `POST /auth/password` | Stores the new tokens; signs out other devices |
| `getMe()` | `GET /users/me` | |
| `updateMe(changes)` | `PATCH /users/me` | |
| `checkUsername(username, signal?)` | `GET /users/username-availability` | |
| `getMyStream()` | `GET /streams/me` | `null` if no key yet |
| `updateStreamTitle(title)` | `PATCH /streams/me` | |
| `generateStreamKey()` | `POST /streams/me/key` | Creates or replaces the key |
| `listLiveStreams(page?)` | `GET /streams` | **Public**; keep current with WebSocket events |
| `subscribeEvents(listener, onReconnect?)` | `WS /ws` | One shared connection; see `useServerEvents` |
| `getLiveStream(id)` | `GET /streams/:id` | **Public**; 404 once ended |
| `getLiveStreamByUsername(username)` | `GET /streams/:username` | **Public**; returns `live` / `offline` / `not-found` |
| `listMyVods(page?)` | `GET /vods/me` | |
| `listUserVods(userId, page?)` | `GET /users/:userId/vods` | |
| `getVod(id)` | `GET /vods/:id` | |
| `deleteVod(id)` | `DELETE /vods/:id` | Owner only |
| `getChatHistory(streamId, { before?, limit? })` | `GET /streams/:id/chat` | **Public**; oldest first, `hasMore` for paging |
| `sendChatMessage(streamId, text)` | `POST /streams/:id/chat` | Live streams only; 429 / 403 / 404 |
| `getChatPermissions(streamId)` | `GET /streams/:id/chat/me` | Role, banned, slow mode, `canModerate` |
| `deleteChatMessage(streamId, messageId)` | `DELETE /streams/:id/chat/:messageId` | Streamer or moderator |
| `banInChat(streamId, userId)` / `unbanInChat(streamId, userId)` | `/streams/:id/chat/bans` | Streamer or moderator |
| `listChatBans()` / `banFromChat(userId)` / `unbanFromChat(userId)` | `/streams/me/bans` | Streamer's own channel |
| `listModerators()` / `addModerator(userId)` / `removeModerator(userId)` | `/streams/me/moderators` | Streamer's own channel |
| `updateStream({ title?, chatSlowModeSeconds? })` | `PATCH /streams/me` | Title and slow mode |
| `joinChat(streamId)` | WS `chat.join` / `chat.leave` | Ref-counted; returns a leave function |

The `/webhooks/mediamtx/*` endpoints are for the media server only. The web app never calls them.

---

### Gotchas

1. **CORS:** the React app's exact origin (scheme + host + port) must be in the API's `CORS_ORIGINS`. Otherwise the browser reports a CORS error and the request never reaches your code.
2. **Google ID token, not access token:** use `<GoogleLogin>`'s `credential`. Its client ID must be in the API's `GOOGLE_CLIENT_IDS`, and the app's origin must be an authorized JavaScript origin on that client.
3. **Store tokens from every auth response:** login, refresh and `setPassword` all return a new refresh token, and the old one stops working. The functions above do this for you; don't call `/auth/*` with raw `fetch`.
4. **Don't refresh in parallel yourself:** always go through `api()` / `refreshTokens()`. Two refreshes with the same token log the user out.
5. **Send only the fields an endpoint accepts.** Spreading the whole `user` object into `updateMe` gets `400 property id should not exist`.
6. **Dates are ISO 8601 strings in UTC.** Convert them with `new Date(...)`.
7. **`hasPassword`** decides between "Set password" (no current password) and "Change password" (current password required).
8. **Stream key secrecy:** don't log `encoderStreamKey`, send it to analytics, or show it unmasked by default.
9. **WebSocket URL has no `/v1`:** it's `ws://host:port/ws`. Events aren't replayed after a disconnect; `useServerEvents`' `onReconnect` reloads state.
10. **Chat needs `chat.join`:** without it the socket never delivers `chat.message`. Use `joinChat()`/`useChat()` rather than sending raw frames, so joins survive reconnects.

---

## Error reference

| Status | Meaning | Typical client action |
|---|---|---|
| 400 | Validation failed; `message` lists the reasons | Show the errors next to the form fields |
| 401 `Unauthorized` | Access token missing, invalid or expired | Call `/auth/refresh`, then retry once |
| 401 `Invalid refresh token` | Session is gone | Send the user to sign-in |
| 401 `Invalid credentials` / `Invalid Google token` / `Current password is incorrect` | Bad sign-in input | Show an error |
| 404 `User not found` | Account was deleted | Clear tokens, send the user to sign-in |
| 403 | Not allowed to change this resource (webhooks: IP not allowed) | Hide the action for resources the user doesn't own |
| 404 `Stream not found` / `VOD not found` / `User is not live` | Doesn't exist (or the stream ended) | Show "not found"; for an ended stream, open the VOD with the same `id` |
| 403 `You are banned from this chat` | The streamer banned you | Disable the chat input |
| 409 | Unique value already taken | Ask for a different value |
| 429 `You are sending messages too fast` | Chat rate limit (`CHAT_MESSAGE_INTERVAL_MS`) | Keep the text and let the user retry a moment later |
| 429 `Slow mode is on: wait N s …` | Chat slow mode (viewers) | Show the wait time; keep the text |
| 403 `Only the streamer and moderators can do this` / `Moderators can't ban other moderators` | Moderation not allowed | Hide those controls (see `GET /streams/:id/chat/me`) |
| 500 | Unexpected server error | Retry later |

In the React client every failed call throws `ApiError` with `status` and `messages: string[]`, and validation errors carry several messages. 401 `Unauthorized` is handled by the fetch wrapper (refresh, then retry). If it still reaches your code, the user is logged out. Messages are in English and come straight from the API; map them to your own strings if you need localisation.

---

## Configuration

Set in `.env` (see `.env.example`). The server won't start if any of these is missing.

| Variable | Example | Description |
|---|---|---|
| `PORT` | `8000` | HTTP port (REST and WebSocket) |
| `API_PREFIX` | `v1` | Prefix for every route |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated browser origins allowed to call the API (web clients) |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` | `localhost`, `5432`, … | PostgreSQL connection |
| `JWT_ACCESS_SECRET` | long random string | Signs access tokens. Changing it invalidates every access token. |
| `JWT_ACCESS_TTL` | `900` | Access token lifetime in seconds |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token lifetime in days |
| `GOOGLE_CLIENT_IDS` | `123-web.apps.googleusercontent.com,123-ios.apps.googleusercontent.com` | Comma-separated Google OAuth client IDs whose ID tokens are accepted |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection (live streams) |
| `HLS_BASE_URL` | `http://localhost:8888` | MediaMTX's public HLS address. Original = `<HLS_BASE_URL>/live/<id>/index.m3u8`; renditions = `<HLS_BASE_URL>/watch/<id>/<quality>/index.m3u8` |
| `MEDIAMTX_API_URL` | `http://127.0.0.1:8088` | MediaMTX's control API (`apiAddress` in mediamtx.yml, with `api: yes`), polled for viewer counts. Don't expose it publicly: it's excluded from auth. |
| `VIEWERS_POLL_SECONDS` | `5` | How often viewer counts are refreshed and `stream.viewers` is sent |
| `STREAM_RENDITIONS` | `1080,720,480` | Qualities the MediaMTX transcoder publishes to `watch/<id>/<quality>`; returned as `renditions`, highest first |
| `WEBHOOK_ALLOWED_IPS` | `127.0.0.1,::1,10.0.0.0/8` | Comma-separated IPs or CIDR masks (IPv4 or IPv6) allowed to call `/webhooks/*`, i.e. MediaMTX's address. An invalid entry stops the server at startup. |
| `CHAT_MESSAGE_INTERVAL_MS` | `1000` | Minimum time between two chat messages from the same user, in any chat. Applies to everyone (slow mode is extra, per channel, viewers only). |
| `STREAM_PUBLISH_URL` | `rtmp://localhost:1935/live` | MediaMTX's public RTMP address plus `/live`, returned as `publishUrl`. It's saved on the user's stream settings when the key is generated, so changing it only affects keys generated afterwards. |

The database schema is created and updated automatically from the entities at startup (TypeORM `synchronize`). There are no migrations.

The WebSocket path `/ws` is fixed and not configurable.

---

## Known limitations

- **Simultaneous first sign-in:** if the same new user calls `POST /auth/google` twice at the same moment, one request can fail with `500` on the unique email. Retrying succeeds.
- **Revocation delay:** after logout, a password change or account deletion, existing access tokens stay valid until they expire (up to `JWT_ACCESS_TTL`).
- **No rate limiting** on `/auth/login` or the other auth endpoints yet.
- **Expired sessions accumulate:** expired refresh-token rows are never cleaned up automatically.
- **Viewer counts are approximate:**
  - A viewer who leaves still counts for about 40 s.
  - Switching quality briefly counts the viewer twice (old and new session), which can raise `peakViewers` slightly.
  - Counts only refresh every `VIEWERS_POLL_SECONDS`, and stop updating if the MediaMTX API is unreachable. The API logs a warning when that happens.
- **Nothing fills `previewUri` / `videoUri` yet.** The media pipeline needs a way to write them (e.g. an internal endpoint), which doesn't exist yet.
- **Stale streams:** a live session stays in Redis until the offline webhook arrives. If MediaMTX crashes or the `curl` call fails, the session isn't ended automatically.
- **Replacing a key doesn't cut off a live broadcast:** someone already broadcasting with a leaked key keeps going until they disconnect. Kicking them would need a call to MediaMTX's control API.
- **Automatic schema changes:** `synchronize` can drop columns, and their data, when entity properties are renamed or removed. Don't run it against a production database without a backup.
- **`stream.*` events are broadcast to everyone:** every client gets `stream.viewers` for all live streams. That's fine for a moderate number of concurrent streams (chat events already use per-stream rooms).
- **Missed events aren't replayed:** a client that was disconnected must reload over REST (the React hooks do this on reconnect).
- **Chat limitations:**
  - There's no word filter and no temporary timeouts (bans are until lifted).
  - `senderRole` is a snapshot: messages sent before a promotion or demotion keep their old badge.
  - A ban doesn't remove the user's earlier messages.
  - Chat history is never trimmed.
