/**
 * @module base-client
 *
 * Template-method base for every Meta platform client.
 *
 * Before Phase 3B, WhatsApp / Messenger / Instagram each hand-rolled the same
 * webhook verification, payload normalization, handler dispatch, and Hono
 * routing — roughly 25 % duplicated LOC across three 1,000-line files. The
 * {@link BaseMetaClient} captures that common machinery once and exposes the
 * platform-specific seams as abstract template methods.
 *
 * ## Behavior change (C-13.5) — per-handler error aggregation
 *
 * In the pre-migration clients, a single failing message handler would throw
 * out of the dispatch loop and block subsequent siblings (the webhook
 * returned 500 even when the fault was in user code, not the platform).
 *
 * The base class now isolates each handler invocation. Failures are collected
 * into a `HandlerDispatchError[]` and optionally forwarded to an
 * `onHandlerError` callback; the webhook itself returns 200 so Meta does not
 * retry on user-code bugs. Consumers that relied on the old fail-fast behavior
 * must register an `onHandlerError` callback to surface errors.
 */

import type { Hono } from 'hono';
import { Hono as HonoCtor } from 'hono';

import type {
  FormatConverter,
  HealthCheckResult,
  InboundMessage,
  InteractiveMessage,
  MediaDownload,
  MediaHandle,
  MediaPayload,
  MediaUploadOptions,
  MessageHandler,
  PlatformClient,
  ReactionData,
  ReactionHandler,
  SendResult,
  StatusHandler,
  StatusUpdate,
} from '@kuralle-agents/messaging';

import { verifySignature } from './webhook/verifier.js';
import { normalizeWebhook } from './webhook/normalizer.js';
import type {
  NormalizedMessage,
  NormalizedStatus,
  NormalizedReaction,
  NormalizedWebhookEvents,
} from './webhook/normalizer.js';
import type { GraphAPIClient } from './graph-api/client.js';

/**
 * A handler failure captured during webhook dispatch.
 *
 * Handlers are isolated so one failing handler cannot block siblings.
 */
export interface HandlerDispatchError {
  /** Which kind of handler threw. */
  kind: 'message' | 'status' | 'reaction';
  /** Event identifier — `messageId` for status/reaction, normalized `id` for messages. */
  eventId: string;
  /** The original error. */
  error: Error;
}

/** Callback invoked when one or more handlers throw during a single webhook. */
export type HandlerErrorCallback = (errors: HandlerDispatchError[]) => void | Promise<void>;

/** Common shape every Meta client config exposes (plus platform-specific fields). */
export interface BaseMetaClientConfig {
  /** App secret for webhook HMAC verification. */
  appSecret: string;
  /** Verify token used during GET subscription challenges. */
  verifyToken: string;
  /** Optional callback to receive aggregated handler-dispatch errors. */
  onHandlerError?: HandlerErrorCallback;
}

/**
 * Template-method base class for Meta platform clients.
 *
 * Type parameters:
 * - `TInbound`   — raw platform inbound payload type (usually {@link NormalizedMessage}).
 * - `TOutbound`  — raw platform outbound envelope type.
 * - `TConfig`    — platform-specific config extending {@link BaseMetaClientConfig}.
 */
export abstract class BaseMetaClient<
  TInbound extends NormalizedMessage = NormalizedMessage,
  TOutbound = Record<string, unknown>,
  TConfig extends BaseMetaClientConfig = BaseMetaClientConfig,
> implements PlatformClient<TConfig, string, TInbound, TOutbound>
{
  /** Platform identifier. Subclasses MUST set this via a `readonly` field. */
  abstract readonly platform: string;

  protected readonly baseConfig: TConfig;
  protected readonly graphApi: GraphAPIClient;
  protected readonly messageHandlers: MessageHandler<TInbound>[] = [];
  protected readonly statusHandlers: StatusHandler[] = [];
  protected readonly reactionHandlers: ReactionHandler[] = [];

  protected constructor(config: TConfig, graphApi: GraphAPIClient) {
    this.baseConfig = config;
    this.graphApi = graphApi;
  }

  // =========================================================================
  // Handler registration
  // =========================================================================

  onMessage(handler: MessageHandler<TInbound>): void {
    this.messageHandlers.push(handler);
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.push(handler);
  }

  onReaction(handler: ReactionHandler): void {
    this.reactionHandlers.push(handler);
  }

  // =========================================================================
  // Webhook dispatch — template method
  // =========================================================================

  /**
   * Full webhook handler: GET verification + POST event dispatch.
   *
   * Guarantees:
   * - GET with matching `hub.mode === 'subscribe'` + verify token → 200 + challenge.
   * - POST without a valid HMAC → 401.
   * - POST with malformed JSON bubbles the `JSON.parse` error to the caller.
   * - POST with isolated handler failures → 200, errors surfaced via
   *   `onHandlerError` (see {@link HandlerDispatchError}).
   */
  async handleWebhook(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      return this.handleVerification(request);
    }

    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256');

    if (
      !signature ||
      !verifySignature({
        appSecret: this.baseConfig.appSecret,
        rawBody,
        signatureHeader: signature,
      })
    ) {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = JSON.parse(rawBody);
    const events = normalizeWebhook(payload);

    const errors = await this.dispatchEvents(events);

    if (errors.length > 0 && this.baseConfig.onHandlerError) {
      try {
        await this.baseConfig.onHandlerError(errors);
      } catch {
        // Error reporting failures must not affect the webhook response.
      }
    }

    return new Response('OK', { status: 200 });
  }

  /** Sub-app that mounts GET + POST /webhook onto a fresh Hono router. */
  webhookRouter(): Hono {
    const app = new HonoCtor();
    app.get('/webhook', async (c) => this.handleWebhook(c.req.raw));
    app.post('/webhook', async (c) => this.handleWebhook(c.req.raw));
    return app;
  }

  // =========================================================================
  // Template-method seams (abstract — subclasses implement)
  // =========================================================================

  /** Normalize a {@link NormalizedMessage} into the canonical {@link InboundMessage}. */
  protected abstract toInboundMessage(msg: NormalizedMessage): InboundMessage;

  /** Normalize a {@link NormalizedStatus} into the canonical {@link StatusUpdate}. */
  protected abstract toStatusUpdate(status: NormalizedStatus): StatusUpdate;

  /** Normalize a {@link NormalizedReaction} into the canonical {@link ReactionData}. */
  protected abstract toReactionData(reaction: NormalizedReaction): ReactionData;

  // PlatformClient outbound methods — subclasses implement.
  abstract sendText(to: string, text: string): Promise<SendResult>;
  abstract sendMedia(to: string, media: MediaPayload): Promise<SendResult>;
  abstract sendInteractive(to: string, msg: InteractiveMessage): Promise<SendResult>;
  abstract sendRaw(to: string, payload: TOutbound): Promise<SendResult>;
  abstract markAsRead(messageId: string): Promise<void>;
  abstract sendTypingIndicator(to: string): Promise<void>;
  abstract uploadMedia(
    file: Buffer | ReadableStream,
    options: MediaUploadOptions,
  ): Promise<MediaHandle>;
  abstract downloadMedia(mediaId: string): Promise<MediaDownload>;

  /** Platform-native text-format converter. */
  abstract readonly formatConverter: FormatConverter;

  /**
   * Optional liveness probe. Left as an optional property so subclasses can
   * either omit it entirely (no /health route) or provide a concrete method.
   */
  healthCheck?(): Promise<HealthCheckResult>;

  // =========================================================================
  // Private — webhook internals
  // =========================================================================

  private handleVerification(request: Request): Response {
    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === this.baseConfig.verifyToken) {
      return new Response(challenge ?? '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  /**
   * Run every registered handler for every event. Isolates each handler
   * invocation so one failure does not block siblings.
   */
  private async dispatchEvents(
    events: NormalizedWebhookEvents,
  ): Promise<HandlerDispatchError[]> {
    const errors: HandlerDispatchError[] = [];

    for (const msg of events.messages) {
      const inbound = this.toInboundMessage(msg);
      for (const handler of this.messageHandlers) {
        try {
          await handler(inbound, msg as TInbound);
        } catch (err) {
          errors.push({ kind: 'message', eventId: msg.id, error: err as Error });
        }
      }
    }

    for (const status of events.statuses) {
      const update = this.toStatusUpdate(status);
      for (const handler of this.statusHandlers) {
        try {
          await handler(update);
        } catch (err) {
          errors.push({ kind: 'status', eventId: status.id, error: err as Error });
        }
      }
    }

    for (const reaction of events.reactions) {
      const data = this.toReactionData(reaction);
      for (const handler of this.reactionHandlers) {
        try {
          await handler(data);
        } catch (err) {
          errors.push({ kind: 'reaction', eventId: reaction.messageId, error: err as Error });
        }
      }
    }

    return errors;
  }
}
