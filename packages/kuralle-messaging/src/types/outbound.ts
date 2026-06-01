import type { HarnessStreamPart } from '@kuralle-agents/core';
import type { WindowState } from '../adapter/window-store.js';
import type { InteractiveMessage, MediaPayload } from './messages.js';
import type { SendResult } from './responses.js';
import type { PlatformClient } from './client.js';

/** Channel-neutral template component (R-10). Maps to the platform's native shape at the sink. */
export interface OutboundTemplateComponent {
  type: 'header' | 'body' | 'button';
  /** Positional parameter values for this component. */
  params?: string[];
  /** Button sub-type (e.g. `quick_reply`, `url`). */
  subType?: string;
  /** Zero-based button index. */
  index?: number;
}

/** A channel-neutral template payload (RFC §4.2). */
export interface OutboundTemplate {
  name: string;
  language: string;
  namedParams?: Record<string, string>;
  positionalParams?: string[];
  components?: OutboundTemplateComponent[];
  raw?: unknown;
}

/** The channel-neutral send surface the OutboundPipeline terminates in (RFC §4.2). */
export interface OutboundSink {
  sendText(to: string, text: string): Promise<SendResult>;
  sendInteractive(to: string, msg: InteractiveMessage): Promise<SendResult>;
  sendMedia(to: string, media: MediaPayload): Promise<SendResult>;
  sendTemplate?(to: string, t: OutboundTemplate): Promise<SendResult>;
}

/** Capability detection — true when the client can send templates (window-agnostic payload). */
export function isTemplateCapable(
  c: PlatformClient,
): c is PlatformClient & Required<Pick<OutboundSink, 'sendTemplate'>> {
  return typeof (c as { sendTemplate?: unknown }).sendTemplate === 'function';
}

export type OutboundPayload =
  | { kind: 'text'; text: string }
  | { kind: 'interactive'; interactive: InteractiveMessage }
  | { kind: 'media'; media: MediaPayload }
  | { kind: 'template'; template: OutboundTemplate };

export interface OutboundMeta {
  window: WindowState;
  parts: HarnessStreamPart[];
  sessionId: string;
  userId?: string;
}

export interface OutboundRequest {
  threadId: string;
  platform: string;
  payload: OutboundPayload;
  meta: OutboundMeta;
}

export type DeferReason = 'window-closed' | 'window-closed-no-recovery' | (string & {});

export type SendOutcome =
  | { kind: 'sent'; result: SendResult }
  | { kind: 'converted'; result: SendResult; template: string; from: string }
  | { kind: 'deferred'; reason: DeferReason }
  | { kind: 'suppressed'; reason: string };

export type OutboundNext = (req: OutboundRequest) => Promise<SendOutcome>;

export interface OutboundMiddleware {
  readonly name: string;
  send(req: OutboundRequest, next: OutboundNext): Promise<SendOutcome>;
}
