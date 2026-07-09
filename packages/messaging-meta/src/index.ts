/**
 * @module @kuralle-agents/messaging-meta
 *
 * Meta platform clients (WhatsApp, Messenger, Instagram) for Kuralle messaging.
 *
 * This is the main entry point for the package. It re-exports the shared
 * Graph API foundation (client, retry, rate limiter, errors) and the webhook
 * utilities (signature verification, payload normalization).
 *
 * Platform-specific clients are available via subpath imports:
 * - `@kuralle-agents/messaging-meta/whatsapp`
 * - `@kuralle-agents/messaging-meta/messenger`
 * - `@kuralle-agents/messaging-meta/instagram`
 *
 * Webhook utilities (verifier + normalizer without the Graph API client):
 * - `@kuralle-agents/messaging-meta/webhooks`
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Graph API foundation
// ---------------------------------------------------------------------------

export { GraphAPIClient } from './graph-api/client.js';
export type { GraphAPIClientConfig, Logger } from './graph-api/client.js';

export { MetaErrorClassifier, metaUsageHeaderParser } from './graph-api/meta-error-classifier.js';

// ---------------------------------------------------------------------------
// BaseMetaClient template-method base (Phase 3B)
// ---------------------------------------------------------------------------

export {
  SmartSplitter,
  TruncateSplitter,
  ByteLimitSplitter,
} from './message-splitter.js';
export type { MessageSplitter } from './message-splitter.js';

export { graphemeCount, sliceGraphemes, graphemes } from './unicode.js';

export { BaseMetaClient } from './base-client.js';
export type {
  BaseMetaClientConfig,
  HandlerDispatchError,
  HandlerErrorCallback,
} from './base-client.js';

// `runBaseMetaClientContract` lives in `test/base-client-contract.ts`
// (it imports `bun:test` and therefore cannot be compiled into the published
// package). Per-client contract tests import it relatively.

export {
  classifyMetaError,
  MessagingError,
  RateLimitError,
  AuthenticationError,
  PermissionError,
  RecipientError,
  WindowClosedError,
  TemplateError,
  MediaError,
  WebhookVerificationError,
} from './graph-api/errors.js';
export type { MetaErrorResponse } from './graph-api/errors.js';

// ---------------------------------------------------------------------------
// Webhook utilities
// ---------------------------------------------------------------------------

export { verifySignature } from './webhook/verifier.js';
export type { VerifySignatureOptions } from './webhook/verifier.js';

export { normalizeWebhook } from './webhook/normalizer.js';
export type {
  NormalizedWebhookEvents,
  NormalizedMessage,
  NormalizedStatus,
  NormalizedReaction,
} from './webhook/normalizer.js';

// ---------------------------------------------------------------------------
// Platform clients (placeholder — will be populated as clients are built)
// ---------------------------------------------------------------------------

// export { WhatsAppClient } from './whatsapp/index.js';
export { MessengerClient, createMessengerClient } from './messenger/index.js';
export type { MessengerClientConfig } from './messenger/index.js';
export { InstagramClient, createInstagramClient } from './instagram/index.js';
export type { InstagramClientConfig } from './instagram/index.js';
