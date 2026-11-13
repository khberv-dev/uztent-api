/** One transcoded quality of a live stream (MediaMTX path `watch/<streamId>/<quality>`). */
export interface Rendition {
  /** e.g. `1080p` */
  quality: string;
  /** HLS playlist URL */
  url: string;
}

/** A live stream. Lives only in Redis, from start until end. */
export interface LiveStream {
  id: string;
  userId: string;
  title: string;
  /** ISO 8601 */
  startedAt: string;
  viewers: number;
  /** HLS URL of the original broadcast: `<HLS_BASE_URL>/live/<streamId>/index.m3u8`. */
  url: string;
  /** Transcoded qualities, highest first (STREAM_RENDITIONS). */
  renditions: Rendition[];
  /** Seconds viewers must wait between chat messages (0 = off). */
  chatSlowModeSeconds: number;
}
