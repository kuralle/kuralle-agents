/**
 * @module graph-api
 *
 * Graph API sub-module — typed HTTP client (thin Meta adapter over
 * `@kuralle-agents/http-client`) + Meta-specific error classification.
 *
 * Retry and rate-limit primitives now live in `@kuralle-agents/http-client`.
 */

export { GraphAPIClient } from './client.js';
export type { GraphAPIClientConfig, Logger } from './client.js';

export { MetaErrorClassifier, metaUsageHeaderParser } from './meta-error-classifier.js';

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
} from './errors.js';
export type { MetaErrorResponse } from './errors.js';
