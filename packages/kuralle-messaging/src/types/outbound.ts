import type { InteractiveMessage, MediaPayload } from './messages.js';
import type { SendResult } from './responses.js';
import type { PlatformClient } from './client.js';

/** A channel-neutral template payload (RFC §4.2). Component-aware enrichment (`components?`) is Sprint 2 (B2). */
export interface OutboundTemplate {
  name: string;
  language: string;
  namedParams?: Record<string, string>;
  positionalParams?: string[];
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
