import type {
  HarnessStreamPart,
  ResolvedSelection,
  SignalDelivery,
  UserInputContent,
} from '@kuralle-agents/core';
import type { ConsentStore } from '../adapter/consent-store.js';
import type { MediaResolver } from './ports.js';
import type { OwnershipStore } from '../adapter/ownership-store.js';
import type { ReactionData, StatusUpdate, InboundMessage } from '../types/messages.js';
import type { WindowStore } from '../adapter/window-store.js';
import type { ConversationKey, InboundLedger } from './ledger.js';

export type NormalizedWebhookError = {
  code?: string | number;
  title?: string;
  message?: string;
  phoneNumberId?: string;
  raw?: unknown;
};

export type InboundEvent =
  | { kind: 'message'; id: string; ts: number; data: InboundMessage }
  | { kind: 'status'; id: string; ts: number; data: StatusUpdate }
  | { kind: 'reaction'; id: string; ts: number; data: ReactionData }
  | { kind: 'error'; id: string; ts: number; data: NormalizedWebhookError }
  | {
      kind: 'signal';
      id: string;
      ts: number;
      data: { name: string; signalId: string; payload?: unknown };
    };

export interface TurnResult {
  parts: HarnessStreamPart[];
  suspended?: { signalId: string };
  handoffToHuman?: boolean;
}

export interface TurnRunner {
  runTurn(a: {
    key: ConversationKey;
    input: UserInputContent;
    selection?: ResolvedSelection;
    userId?: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<TurnResult>;
  deliverSignal(a: {
    key: ConversationKey;
    signal: SignalDelivery;
    sessionId?: string;
    signal2?: AbortSignal;
  }): Promise<TurnResult>;
}

export interface CoalesceScheduler {
  arm(key: ConversationKey, atMs: number): Promise<void>;
  cancel(key: ConversationKey): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface OutboundSender {
  send(ctx: InboundContext, result: TurnResult): Promise<void>;
}

export interface InboundRuntime {
  ledger: InboundLedger;
  window: WindowStore;
  consent?: ConsentStore;
  ownership?: OwnershipStore;
  media: MediaResolver;
  sender: OutboundSender;
  runtime: TurnRunner;
  scheduler: CoalesceScheduler;
  clock: Clock;
}

export type InboundOutcome =
  | { kind: 'ran'; parts: HarnessStreamPart[] }
  | { kind: 'suspended'; signalId: string }
  | { kind: 'buffered' }
  | {
      kind: 'short';
      by: string;
      reason:
        | 'duplicate'
        | 'opted-out'
        | 'human-owned'
        | 'window-closed'
        | 'no-input'
        | 'in-progress'
        | string;
    };

export interface InboundContext {
  key: ConversationKey;
  event: InboundEvent;
  rt: InboundRuntime;
  input?: UserInputContent;
  selection?: ResolvedSelection;
  sessionId?: string;
  userId?: string;
  locals: Record<string, unknown>;
}

export type InboundNext = () => Promise<InboundOutcome>;

export interface InboundMiddleware {
  readonly name: string;
  handle(ctx: InboundContext, next: InboundNext): Promise<InboundOutcome>;
}

