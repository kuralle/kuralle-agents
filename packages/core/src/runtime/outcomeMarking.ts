import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type {
  ConversationOutcome,
  ConversationOutcomeMarkedBy,
  ConversationOutcomeRecord,
} from '../outcomes/types.js';
import type { HarnessStreamPart } from '../types/stream.js';

export function isTerminalOutcome(outcome: ConversationOutcome): boolean {
  return outcome === 'resolved' || outcome === 'escalated' || outcome === 'abandoned';
}

export async function markSessionOutcome(
  sessionStore: SessionStore,
  session: Session,
  outcome: ConversationOutcome,
  opts: { reason?: string; markedBy?: ConversationOutcomeMarkedBy } = {},
  emit?: (part: HarnessStreamPart) => void,
): Promise<ConversationOutcomeRecord> {
  const now = new Date();
  session.metadata ??= {
    createdAt: session.createdAt,
    lastActiveAt: now,
    totalTokens: 0,
    totalSteps: 0,
    handoffHistory: [],
  };

  const record: ConversationOutcomeRecord = {
    outcome,
    ...(opts.reason ? { reason: opts.reason } : {}),
    markedAt: now.toISOString(),
    markedBy: opts.markedBy ?? 'hook',
  };

  session.metadata.outcome = record;
  session.updatedAt = now;
  session.metadata.lastActiveAt = now;
  await sessionStore.save(session);

  if (emit) {
    emit({
      type: 'conversation-outcome',
      outcome: record.outcome,
    });
  }

  return record;
}
