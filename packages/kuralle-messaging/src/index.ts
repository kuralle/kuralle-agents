// ====================================
// Types
// ====================================
export type {
  PlatformClient,
  InboundMessage,
  StatusUpdate,
  SendResult,
  MediaPayload,
  MediaHandle,
  MediaDownload,
  MediaUploadOptions,
  MediaReference,
  InteractiveMessage,
  InteractiveAction,
  InteractiveReply,
  ContactInfo,
  LocationData,
  ReactionData,
  MessageContext,
  ConversationInfo,
  PricingInfo,
  StatusError,
  FormatConverter,
  MessageHandler,
  StatusHandler,
  ReactionHandler,
  MessagingRouterConfig,
  SessionResolver,
  ResponseMapper,
  ResponseContext,
  ErrorContext,
  StreamMapperOptions,
  HealthCheckResult,
} from './types.js';

// ====================================
// Errors
// ====================================
export {
  MessagingError,
  RateLimitError,
  WindowClosedError,
  AuthenticationError,
  PermissionError,
  RecipientError,
  TemplateError,
  MediaError,
  WebhookVerificationError,
} from './errors.js';

// ====================================
// Adapter
// ====================================
export { createMessagingRouter } from './adapter/createMessagingRouter.js';
export { defaultSessionResolver } from './adapter/session-resolver.js';
export {
  SessionResolverChain,
  ThreadIdResolver,
  PhoneLookupResolver,
} from './adapter/session-resolver-chain.js';
export type { SessionResolverPlugin } from './adapter/session-resolver-chain.js';
export { StreamMapper } from './adapter/stream-mapper.js';
export { WindowTracker } from './adapter/window-tracker.js';
export type { WindowStore, WindowState } from './adapter/window-store.js';
export { InMemoryWindowStore } from './adapter/window-store.js';

// ====================================
// Shared
// ====================================
export { MessageDeduplicator } from './shared/deduplicator.js';
export { passthroughFormatter } from './shared/format-base.js';
export type { MessageFormatter } from './shared/format-base.js';
export { MediaCache } from './shared/media-cache.js';
export type { MediaCacheConfig, CachedMedia } from './shared/media-cache.js';
export {
  HttpUrlStrategy,
  UploadStrategy,
  FileHashDedupStrategy,
} from './shared/media-strategy.js';
export type {
  MediaStrategy,
  ResolvedMedia,
  MediaUploader,
  UploadHandleStore,
} from './shared/media-strategy.js';

// ====================================
// Stream filter
// ====================================
export { filterStreamParts } from './stream-filter.js';

// ====================================
// Outbound
// ====================================
export type { OutboundSink, OutboundTemplate } from './types/outbound.js';
export { isTemplateCapable } from './types/outbound.js';
