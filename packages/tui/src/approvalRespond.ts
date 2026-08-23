import type { InputResponse, TurnView } from '@kuralle-agents/client';

export type PendingInterrupt = TurnView['pending'][number];

export function buildApprovalResponse(
  interrupt: PendingInterrupt,
  decision: 'approve' | 'deny',
): InputResponse[] {
  return [{ requestId: interrupt.requestId, decision }];
}
