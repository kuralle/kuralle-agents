import type { InboundMessage, InteractiveMessage } from '@kuralle-agents/messaging';
import type { ResolvedSelection } from '@kuralle-agents/core';
import type { ChannelPolicy, ChoiceOption } from '../policy.js';

/** Web/SSE null policy — no window, no consent (RFC §4.12). Proves the abstraction. */
export function webPolicy(): ChannelPolicy {
  return {
    channel: 'web',
    hasWindow: false,
    async isWindowOpen() {
      return true;
    },
    closedWindow: { kind: 'none' },
    consentRequired: false,
    renderInteractive(options: ChoiceOption[], prompt: string): InteractiveMessage {
      return {
        type: 'buttons',
        body: prompt,
        action: { type: 'buttons', buttons: options.map((o) => ({ id: o.id, title: o.label })) },
      };
    },
    resolveInbound(m: InboundMessage): { input: string; selection?: ResolvedSelection } {
      return { input: m.text ?? '' };
    },
  };
}
