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
  InboundCoalescingConfig,
  CoalescedInboundItem,
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
export { createInputCoalescer } from './adapter/input-coalescer.js';
export type { InputCoalescer, InputCoalescerOptions } from './adapter/input-coalescer.js';
export { defaultSessionResolver } from './adapter/session-resolver.js';
export {
  SessionResolverChain,
  ThreadIdResolver,
  PhoneLookupResolver,
} from './adapter/session-resolver-chain.js';
export type { SessionResolverPlugin } from './adapter/session-resolver-chain.js';
export {
  InboundResolverChain,
  InteractiveResolver,
  TextResolver,
  defaultInboundChain,
} from './adapter/input-resolver-chain.js';
export type { InboundResolverPlugin } from './adapter/input-resolver-chain.js';
export { attachInboundMedia } from './adapter/inbound-media.js';
export { StreamMapper } from './adapter/stream-mapper.js';
export { WindowTracker } from './adapter/window-tracker.js';
export type { WindowStore, WindowState } from './adapter/window-store.js';
export { InMemoryWindowStore } from './adapter/window-store.js';
export type { RedisLikeClient } from './adapter/redis-client.js';
export { redisSetSucceeded } from './adapter/redis-client.js';
export { createRedisWindowStore } from './adapter/redis-window-store.js';
export type { OwnershipStore, ConversationOwner } from './adapter/ownership-store.js';
export type { ConsentStore } from './adapter/consent-store.js';

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
export { OutboundPipeline } from './adapter/outbound-pipeline.js';
export { windowGuard } from './adapter/middleware/window-guard.js';
export type {
  OutboundSink,
  OutboundTemplate,
  OutboundTemplateComponent,
  OutboundMiddleware,
  OutboundNext,
  OutboundRequest,
  OutboundPayload,
  OutboundMeta,
  SendOutcome,
  DeferReason,
} from './types/outbound.js';
export { isTemplateCapable, isTagCapable } from './types/outbound.js';

export {
  renderChoices,
  BUTTON_TITLE_MAX,
  LIST_ROW_TITLE_MAX,
  BUTTON_COUNT_MAX,
  LIST_ROW_COUNT_MAX,
} from './adapter/render-choices.js';
