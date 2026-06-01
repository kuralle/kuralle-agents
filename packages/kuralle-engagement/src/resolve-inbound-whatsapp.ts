import type { InboundMessage } from '@kuralle-agents/messaging';
import type { ResolvedSelection } from '@kuralle-agents/core';

/** S3 interactive-then-text resolution (sync; mirrors InteractiveResolver + TextResolver). */
export function resolveInboundWhatsApp(m: InboundMessage): {
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
  if (m.interactive?.formResponse) {
    return {
      input: '__flow__',
      selection: { formData: m.interactive.formResponse },
    };
  }
  return { input: m.text ?? '', selection: undefined };
}
