/**
 * @module whatsapp/flows
 *
 * Utilities and types for WhatsApp Flows.
 *
 * WhatsApp Flows are multi-screen forms that run natively inside WhatsApp.
 * This module re-exports the relevant types and provides helper functions
 * for common flow operations.
 *
 * The primary flow management methods (create, update, publish, delete,
 * getAssets) live on the {@link WhatsAppClient} via the `client.flows`
 * namespace. This module provides supplementary helpers.
 *
 * @see https://developers.facebook.com/docs/whatsapp/flows
 */

import type { FlowInteractiveInput } from './types.js';

export type {
  FlowDefinition,
  FlowInfo,
  FlowAssets,
  FlowInteractiveInput,
} from './types.js';

// ---------------------------------------------------------------------------
// Flow token helpers
// ---------------------------------------------------------------------------

/**
 * Generate a random flow token for a WhatsApp Flow session.
 *
 * Flow tokens are opaque strings used to correlate flow responses
 * with the originating business logic. Each flow message should use
 * a unique token.
 *
 * @param length - Length of the generated token. Default `32`.
 * @returns A cryptographically random hex string.
 *
 * @example
 * ```ts
 * const token = generateFlowToken();
 * await client.sendInteractiveFlow(to, {
 *   body: { text: 'Complete your order' },
 *   flowId: '123456789',
 *   flowCta: 'Start',
 *   flowToken: token,
 *   flowAction: 'navigate',
 * });
 * ```
 */
export function generateFlowToken(length: number = 32): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

/**
 * Build a {@link FlowInteractiveInput} payload with sensible defaults.
 *
 * @param options - Flow message options.
 * @returns A complete {@link FlowInteractiveInput} ready to pass to
 *          {@link WhatsAppClient.sendInteractiveFlow}.
 *
 * @example
 * ```ts
 * const flow = buildFlowInput({
 *   bodyText: 'Complete your registration',
 *   flowId: '123456789',
 *   flowCta: 'Get Started',
 * });
 * await client.sendInteractiveFlow(to, flow);
 * ```
 */
export function buildFlowInput(options: {
  /** Body text for the flow message. */
  bodyText: string;
  /** The WhatsApp Flow ID. */
  flowId: string;
  /** Call-to-action button text. */
  flowCta: string;
  /** Optional footer text. */
  footerText?: string;
  /** Flow action type. Default `"navigate"`. */
  flowAction?: 'navigate' | 'data_exchange';
  /** Optional flow token. Auto-generated if not provided. */
  flowToken?: string;
  /** Optional initial payload data. */
  flowActionPayload?: Record<string, unknown>;
}): FlowInteractiveInput {
  return {
    body: { text: options.bodyText },
    footer: options.footerText ? { text: options.footerText } : undefined,
    flowId: options.flowId,
    flowCta: options.flowCta,
    flowToken: options.flowToken ?? generateFlowToken(),
    flowAction: options.flowAction ?? 'navigate',
    flowActionPayload: options.flowActionPayload,
  };
}
