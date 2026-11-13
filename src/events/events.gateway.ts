import type { OnApplicationShutdown } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import { WebSocket, type Server } from 'ws';
import { EventsService } from './events.service.js';
import type { ServerEvent } from './events.types.js';

const PING_INTERVAL_MS = 30_000;
/** Chats one connection can be in at once. */
const MAX_CHATS_PER_CLIENT = 10;

type Client = WebSocket & { isAlive?: boolean; chats?: Set<string> };

/**
 * Public: `ws://<host>:<PORT>/ws`, JSON `{ event, data }` both ways.
 * - stream.* events go to every client.
 * - chat.* events go only to clients that sent `chat.join` for that stream.
 * Sending chat messages is REST (POST /streams/:id/chat), so the socket needs
 * no auth.
 */
@WebSocketGateway({ path: '/ws' })
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnApplicationShutdown
{
  @WebSocketServer() private readonly server: Server;
  private unsubscribe?: () => void;
  private pingTimer?: NodeJS.Timeout;

  constructor(private readonly eventsService: EventsService) {}

  afterInit() {
    this.unsubscribe = this.eventsService.subscribe((event) =>
      this.deliver(event),
    );

    // Drop connections that stopped answering pings (closed tabs, lost network).
    this.pingTimer = setInterval(() => {
      for (const client of this.server.clients as Set<Client>) {
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, PING_INTERVAL_MS);
  }

  handleConnection(client: Client) {
    client.isAlive = true;
    client.chats = new Set();
    client.on('pong', () => {
      client.isAlive = true;
    });
  }

  /** `{ "event": "chat.join", "data": { "streamId": "<live stream id>" } }` */
  @SubscribeMessage('chat.join')
  joinChat(@ConnectedSocket() client: Client, @MessageBody() data: unknown) {
    const streamId = readStreamId(data);
    if (!streamId) return error('chat.join needs data.streamId (uuid)');
    if (
      !client.chats!.has(streamId) &&
      client.chats!.size >= MAX_CHATS_PER_CLIENT
    ) {
      return error(`At most ${MAX_CHATS_PER_CLIENT} chats per connection`);
    }
    client.chats!.add(streamId);
    return { event: 'chat.joined', data: { streamId } };
  }

  /** `{ "event": "chat.leave", "data": { "streamId": "<live stream id>" } }` */
  @SubscribeMessage('chat.leave')
  leaveChat(@ConnectedSocket() client: Client, @MessageBody() data: unknown) {
    const streamId = readStreamId(data);
    if (!streamId) return error('chat.leave needs data.streamId (uuid)');
    client.chats!.delete(streamId);
    return { event: 'chat.left', data: { streamId } };
  }

  onApplicationShutdown() {
    this.unsubscribe?.();
    clearInterval(this.pingTimer);
  }

  private deliver(event: ServerEvent) {
    const message = JSON.stringify(event);
    const chatId =
      event.event === 'chat.message' ||
      event.event === 'chat.deleted' ||
      event.event === 'chat.settings'
        ? event.data.streamId
        : null;

    for (const client of this.server.clients as Set<Client>) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (chatId && !client.chats?.has(chatId)) continue;
      client.send(message);
    }
  }
}

function readStreamId(data: unknown): string | null {
  const streamId = (data as { streamId?: unknown } | null)?.streamId;
  return typeof streamId === 'string' && isUUID(streamId)
    ? streamId.toLowerCase()
    : null;
}

function error(message: string) {
  return { event: 'error', data: { message } };
}
