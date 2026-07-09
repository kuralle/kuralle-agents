/**
 * @module types/client
 *
 * `PlatformClient` master interface + handler types.
 */

import type { Hono } from 'hono';
import type {
  InboundMessage,
  MediaHandle,
  MediaDownload,
  MediaPayload,
  MediaUploadOptions,
  InteractiveMessage,
  ReactionData,
  StatusUpdate,
} from './messages.js';
import type { FormatConverter, SendResult } from './responses.js';

// ====================================
// HANDLER TYPES
// ====================================

/**
 * Handler invoked when an inbound message is received.
 * @typeParam T - The raw platform-specific message type.
 */
export type MessageHandler<T = unknown> = (message: InboundMessage, raw: T) => Promise<void>;

/** Handler invoked when a delivery/read status update is received. */
export type StatusHandler = (status: StatusUpdate) => Promise<void>;

/** Handler invoked when a reaction event is received. */
export type ReactionHandler = (reaction: ReactionData) => Promise<void>;

// ====================================
// PLATFORM CLIENT
// ====================================

/**
 * The master interface that all vendor messaging packages must implement.
 */
export interface PlatformClient<
  TConfig = unknown,
  TThreadId = string,
  TInbound = unknown,
  TOutbound = unknown,
> {
  /** The platform identifier (e.g. "whatsapp", "messenger", "telegram"). */
  readonly platform: string;

  handleWebhook(request: Request): Promise<Response>;

  onMessage(handler: MessageHandler<TInbound>): void;
  onStatus(handler: StatusHandler): void;
  onReaction(handler: ReactionHandler): void;

  sendText(to: TThreadId, text: string): Promise<SendResult>;
  sendMedia(to: TThreadId, media: MediaPayload): Promise<SendResult>;
  sendInteractive(to: TThreadId, msg: InteractiveMessage): Promise<SendResult>;
  sendRaw(to: TThreadId, payload: TOutbound): Promise<SendResult>;

  markAsRead(messageId: string): Promise<void>;
  sendTypingIndicator(to: TThreadId): Promise<void>;

  uploadMedia(file: Buffer | ReadableStream, options: MediaUploadOptions): Promise<MediaHandle>;
  downloadMedia(mediaId: string): Promise<MediaDownload>;

  formatConverter: FormatConverter;

  webhookRouter(): Hono;

  /**
   * Optional liveness probe. When present, `createMessagingRouter` exposes a
   * `/health` route that aggregates every client's result.
   */
  healthCheck?(): Promise<HealthCheckResult>;
}

/** Result of {@link PlatformClient.healthCheck}. */
export interface HealthCheckResult {
  ok: boolean;
  /** Human-readable reason when `ok === false`. */
  reason?: string;
  /** Platform-specific latency / metadata the probe wants to surface. */
  details?: Record<string, unknown>;
}
