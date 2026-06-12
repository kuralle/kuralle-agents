/**
 * @module types
 *
 * Public type surface for `@kuralle-agents/messaging`. Re-exports from
 * domain-scoped files to keep this barrel small (Phase 3B split).
 */

export type {
  ContactInfo,
  LocationData,
  MediaPayload,
  MediaReference,
  MediaHandle,
  MediaDownload,
  MediaUploadOptions,
  InteractiveMessage,
  InteractiveAction,
  InteractiveReply,
  ReactionData,
  MessageContext,
  ConversationInfo,
  PricingInfo,
  StatusError,
  InboundMessage,
  StatusUpdate,
} from './types/messages.js';

export type { SendResult, FormatConverter } from './types/responses.js';

export type {
  MessageHandler,
  StatusHandler,
  ReactionHandler,
  PlatformClient,
  HealthCheckResult,
} from './types/client.js';

export type {
  SessionResolver,
  ResponseContext,
  ResponseMapper,
  ErrorContext,
  MessagingRouterConfig,
  InboundCoalescingConfig,
  CoalescedInboundItem,
  StreamMapperOptions,
} from './types/adapter.js';

export type {
  InboundEvent,
  NormalizedWebhookError,
  InboundRuntime,
  TurnRunner,
  TurnResult,
  CoalesceScheduler,
  Clock,
  OutboundSender,
  InboundOutcome,
  InboundContext,
  InboundNext,
  InboundMiddleware,
} from './inbound/types.js';

export type {
  ClaimResult,
  ConversationKey,
  ConvKeyStr,
  InboundLedger,
  SequencedInboundEvent,
} from './inbound/ledger.js';
