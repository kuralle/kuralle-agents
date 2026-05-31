import type { IncomingMessage } from 'node:http';

export interface WebSocketServerOptions {
  /** Port to listen on. Default: 8080. */
  port?: number;
  /** Host to bind to. Default: '0.0.0.0'. */
  host?: string;
  /** Default audio sample rate. Default: 24000. */
  defaultSampleRate?: number;
  /** Default number of audio channels. Default: 1 (mono). */
  defaultNumChannels?: number;
  /**
   * Send session_started immediately after connection setup.
   *
   * Defaults to true for existing protocol behavior. Set false for handlers
   * that need to finish model/session startup before the client sends audio.
   */
  autoSendSessionStarted?: boolean;
  /** Optional authentication function. Return true to accept, false to reject. */
  authenticate?: (req: IncomingMessage) => boolean | Promise<boolean>;
}
