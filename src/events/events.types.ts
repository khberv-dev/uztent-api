import type { LiveStream } from '../streams/live-stream.interface.js';

/** Messages pushed to WebSocket clients: `{ "event": ..., "data": ... }`. */
export type ServerEvent =
  | { event: 'stream.started'; data: LiveStream }
  | {
      event: 'stream.ended';
      /** `vodId` = `id`: the recording is available as a VOD with the same id. */
      data: { id: string; userId: string; vodId: string };
    }
  | {
      /** Only sent to clients that joined this stream's chat (chat.join). */
      event: 'chat.message';
      data: {
        id: string;
        streamId: string;
        userId: string;
        senderName: string;
        /** Badge: 'streamer' | 'moderator', or null for viewers. */
        senderRole: 'streamer' | 'moderator' | null;
        text: string;
        createdAt: string;
      };
    }
  | {
      /** The streamer changed chat settings. Only sent to the chat's members. */
      event: 'chat.settings';
      data: { streamId: string; slowModeSeconds: number };
    }
  | {
      /** A moderator removed a message. Only sent to the chat's members. */
      event: 'chat.deleted';
      data: { id: string; streamId: string };
    }
  | {
      event: 'stream.viewers';
      /** Every live stream's current count, sent every VIEWERS_POLL_SECONDS. */
      data: { id: string; viewers: number }[];
    };
