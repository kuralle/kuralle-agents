/**
 * @module types/adapter
 *
 * Adapter types: session resolution, response mapping, error context,
 * router config, and stream mapper options.
 */

import type { RuntimeLike, HarnessStreamPart } from '@kuralle-agents/core';
import type { OutboundPipeline } from '../adapter/outbound-pipeline.js';
import type { WindowStore } from '../adapter/window-store.js';
import type { OutboundMiddleware } from './outbound.js';
import type { InboundMessage, InteractiveMessage, MediaPayload, StatusUpdate } from './messages.js';
import type { SendResult } from './responses.js';
import type { PlatformClient, StatusHandler } from './client.js';

/**
 * Resolves an inbound message to a session identifier for the Kuralle runtime.
 */
export interface SessionResolver {
  resolve(message: InboundMessage): Promise<{ sessionId: string; userId?: string }>;
}

/** Context passed to a response mapper for sending platform messages. */
export interface ResponseContext {
  threadId: string;
  platform: string;
  sendText(text: string): Promise<SendResult>;
  sendInteractive(msg: InteractiveMessage): Promise<SendResult>;
  sendMedia(media: MediaPayload): Promise<SendResult>;
}

/**
 * Custom mapper that controls how Kuralle stream output is sent to the platform.
 */
export interface ResponseMapper {
  mapResponse(parts: HarnessStreamPart[], context: ResponseContext): Promise<void>;
}

/** Error context provided to the onError callback. */
export interface ErrorContext {
  message: InboundMessage;
  platform: string;
  error: Error;
}

/**
 * Configuration for creating a messaging router that bridges
 * platform clients with the Kuralle runtime.
 */
export interface MessagingRouterConfig {
  runtime: RuntimeLike;
  platforms: Record<string, PlatformClient>;
  sessionResolver?: SessionResolver;
  responseMapper?: ResponseMapper;
  onStatus?: StatusHandler;
  onError?: (error: Error, context: ErrorContext) => void;
  fallbackMessage?: string;
  /** Extra outbound middleware installed before the non-removable terminal `windowGuard`. */
  outbound?: OutboundMiddleware[];
  /** Pluggable window store; defaults to in-memory (fail-closed on miss). */
  windowStore?: WindowStore;
}

/** Options for the stream mapper. */
export interface StreamMapperOptions {
  responseMapper?: ResponseMapper;
  /** Interval in ms for sending typing indicators during streaming. Default: 5000. */
  typingIntervalMs?: number;
  pipeline: OutboundPipeline;
  windowStore: WindowStore;
  sessionId: string;
  userId?: string;
}
