/**
 * @module webhook
 *
 * Webhook sub-module — signature verification and payload normalization.
 */

export { verifySignature } from './verifier.js';
export type { VerifySignatureOptions } from './verifier.js';

export { normalizeWebhook } from './normalizer.js';
export type {
  NormalizedWebhookEvents,
  NormalizedMessage,
  NormalizedStatus,
  NormalizedReaction,
} from './normalizer.js';
