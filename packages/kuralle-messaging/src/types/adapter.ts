/**
 * @module types/adapter
 *
 * Adapter types: session resolution, response mapping, error context,
 * router config, and stream mapper options.
 */

import type { RuntimeLike, HarnessStreamPart, ResolvedSelection, UserInputContent, InjectableTimer } from '@kuralle-agents/core';
import type { OutboundPipeline } from '../adapter/outbound-pipeline.js';
import type { WindowStore } from '../adapter/window-store.js';
import type { ConsentStore } from '../adapter/consent-store.js';
import type { OwnershipStore } from '../adapter/ownership-store.js';
import type { InboundResolverPlugin } from '../adapter/input-resolver-chain.js';
import type { OutboundMiddleware } from './outbound.js';
import type { InboundMessage, InteractiveMessage, MediaPayload, StatusUpdate } from './messages.js';
import type { SendResult } from './responses.js';
import type { PlatformClient, StatusHandler } from './client.js';
import type { Clock, CoalesceScheduler } from '../inbound/types.js';
import type { InboundLedger } from '../inbound/ledger.js';

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
  /** Custom inbound input resolvers; defaults to `[InteractiveResolver, TextResolver]`. */
  inputResolver?: InboundResolverPlugin[];
  responseMapper?: ResponseMapper;
  onStatus?: StatusHandler;
  onError?: (error: Error, context: ErrorContext) => void;
  fallbackMessage?: string;
  /** Extra outbound middleware installed before the non-removable terminal `windowGuard`. */
  outbound?: OutboundMiddleware[];
  /** Pluggable window store; defaults to in-memory (fail-closed on miss). */
  windowStore?: WindowStore;
  /** Pluggable inbound ledger; defaults to in-memory (single-process/dev). */
  ledger?: InboundLedger;
  /** Host scheduler port; Node defaults to an in-process no-op for M-01. */
  scheduler?: CoalesceScheduler;
  /** Injectable clock for deterministic pipeline tests. */
  clock?: Clock;
  /** When set, human-owned threads skip `runtime.run` on inbound (REQ-21). */
  ownership?: OwnershipStore;
  /** When set, STOP inbound opts the customer out; outbound uses `consentGate` (REQ-11). */
  consent?: ConsentStore;
  /**
   * Per-thread inbound debounce/coalesce before `runtime.run`. Default off (each
   * message is its own turn). See README for `debounceMs`, `maxWaitMs`, DO note.
   */
  inboundCoalescing?: InboundCoalescingConfig;
}

/** Sliding debounce + max-wait cap for burst WhatsApp text-ins. */
export interface InboundCoalescingConfig {
  /** Trailing debounce in ms; `0` disables coalescing (pass-through). Default 3000. */
  debounceMs?: number;
  /** Hard cap from first buffered message (ms). Default 10000. */
  maxWaitMs?: number;
  /** Flush when buffer reaches this count. Default 10. */
  maxMessages?: number;
  /** Immediate flush predicate; default: any resolved interactive selection. */
  flushImmediately?: (item: CoalescedInboundItem) => boolean;
  /** Injectable timer for deterministic tests. */
  timer?: InjectableTimer;
}

/** One resolved inbound waiting in the coalescer or about to run. */
export interface CoalescedInboundItem {
  input: UserInputContent;
  selection?: ResolvedSelection;
  sessionId: string;
  userId?: string;
  message: InboundMessage;
  platform: string;
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
