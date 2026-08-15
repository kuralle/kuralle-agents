import type { InterruptRequest, SignalDelivery } from './types.js';

export const DEADLINE_EXPIRED_REASON = 'deadline-expired';
export const SWEEPER_ACTOR_ID = 'kuralle-sweeper';

export function isDeadlineExpiryDelivery(delivery: SignalDelivery): boolean {
  return (
    delivery.decision === 'deny' &&
    delivery.reason === DEADLINE_EXPIRED_REASON &&
    delivery.actor.type === 'system'
  );
}

export function deadlineExpiryDelivery(waitingFor: InterruptRequest): SignalDelivery {
  return {
    signalId: `deadline:${waitingFor.requestId}`,
    requestId: waitingFor.requestId,
    name: waitingFor.signalName,
    actor: { id: SWEEPER_ACTOR_ID, type: 'system' },
    decision: 'deny',
    reason: DEADLINE_EXPIRED_REASON,
  };
}
