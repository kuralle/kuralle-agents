import type { InboundMessage } from '@kuralle-agents/messaging';
import type { ResolvedSelection } from '@kuralle-agents/core';

export function resolveInboundInstagram(m: InboundMessage): {
  input: string;
  selection?: ResolvedSelection;
} {
  const interactiveId = m.interactive?.id;
  if (interactiveId) {
    return { input: interactiveId, selection: { id: interactiveId } };
  }
  if (m.button?.payload) {
    return { input: m.button.payload, selection: { id: m.button.payload } };
  }
  return { input: m.text ?? '', selection: undefined };
}
