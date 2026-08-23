import type { HitlInterrupt } from '@kuralle-agents/core';
import type { InputRequest, InputRequestOption, InputResponse } from './types.js';
import type { TurnView } from './reduce.js';

function decisionOptions(decisions: Array<'approve' | 'deny'>): InputRequestOption[] {
  return decisions.map((id) => ({
    id,
    label: id === 'approve' ? 'Approve' : 'Deny',
  }));
}

/** Projects a runtime interrupt to the stable agent-facing input request shape. */
export function projectInputRequest(interrupt: HitlInterrupt): InputRequest {
  return {
    requestId: interrupt.requestId,
    kind: interrupt.kind,
    prompt: interrupt.display.title,
    description: interrupt.display.description,
    signalName: interrupt.signalName,
    toolName: interrupt.operation?.toolName,
    options: interrupt.allowedDecisions.length
      ? decisionOptions(interrupt.allowedDecisions)
      : undefined,
  };
}

export type PendingInterrupt = TurnView['pending'][number];

/** The one respond payload both surfaces send. Parity is structural, not a thing a test guesses at. */
export function buildApprovalResponse(
  interrupt: PendingInterrupt,
  decision: 'approve' | 'deny',
): InputResponse[] {
  return [{ requestId: interrupt.requestId, decision }];
}
