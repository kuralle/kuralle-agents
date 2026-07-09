/**
 * OpenAI Realtime family — Cloudflare Workers variants.
 *
 * Three sibling clients speaking the same wire protocol with vendor-specific
 * endpoint + auth + default settings. Composition over inheritance — each
 * vendor class passes a `ProviderProfile` into the shared base.
 */

export {
  OpenAIFamilyRealtimeClient,
  encodeBase64Chunked,
  decodeBase64,
} from './base.js';
export type { OpenAIFamilyOptions, OpenAIFamilyExtraEvent } from './base.js';

export { CloudflareOpenAIRealtimeClient } from './openai.js';
export { CloudflareXAIGrokRealtimeClient } from './xai.js';
export { CloudflareAzureOpenAIRealtimeClient } from './azure.js';
export type { AzureOpenAIRealtimeOptions } from './azure.js';

export { ChatCtxMirror } from './chat-ctx-mirror.js';
export type { ChatCtxItem, ChatCtxRole } from './chat-ctx-mirror.js';

export {
  buildSessionUpdate,
  buildAudioAppend,
  buildToolResponseFrames,
  buildItemCreate,
  buildResponseCancel,
  buildConversationItemTruncate,
  canonicalizeEventName,
  OPENAI_FAMILY_CAPABILITIES,
  OPENAI_PROFILE,
  XAI_PROFILE,
  azureProfile,
  REALTIME_AUDIO_VERSION,
} from './protocol.js';
export type { ProviderProfile, SessionUpdateOpts, AzureProfileOpts, CanonicalEvent, TurnDetection } from './protocol.js';

export { OpenAIFamilySessionState, type SessionState } from './session-state.js';
export {
  OpenAIFamilyMessageQueue,
  DEFAULT_QUEUE_MAX_EVENTS,
  DEFAULT_QUEUE_MAX_BYTES,
  type MessageQueueLimits,
} from './message-queue.js';
