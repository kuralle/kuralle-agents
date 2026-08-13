import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type {
  ConversationOutcome,
  ConversationOutcomeMarkedBy,
  ConversationOutcomeRecord,
} from '../outcomes/types.js';
import type { StreamPart } from '../types/stream.js';
import type { FlowGateVerdict } from '../flows/definition/types.js';
import { appendConversationAudit } from '../audit/record.js';
import { mutateSessionWithRetry } from '../session/utils.js';

export function isTerminalOutcome(outcome: ConversationOutcome): boolean {
  return (
    outcome === 'resolved' ||
    outcome === 'escalated' ||
    outcome === 'abandoned' ||
    outcome === 'failed-verification'
  );
}

export async function markSessionOutcome(
  sessionStore: SessionStore,
  session: Session,
  outcome: ConversationOutcome,
  opts: { reason?: string; markedBy?: ConversationOutcomeMarkedBy; gates?: FlowGateVerdict[] } = {},
  emit?: (part: StreamPart) => void,
): Promise<ConversationOutcomeRecord> {
  const now = new Date();
  const record: ConversationOutcomeRecord = {
    outcome,
    ...(opts.reason ? { reason: opts.reason } : {}),
    markedAt: now.toISOString(),
    markedBy: opts.markedBy ?? 'hook',
    ...(opts.gates && opts.gates.length > 0 ? { gates: opts.gates } : {}),
  };

  const saved = await mutateSessionWithRetry(sessionStore, session.id, (latest) => {
    latest.metadata ??= {
      createdAt: latest.createdAt,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    };
    latest.metadata.outcome = record;
    latest.updatedAt = now;
    latest.metadata.lastActiveAt = now;
    appendConversationAudit(
      latest,
      {
        sessionId: latest.id,
        conversationId: latest.conversationId,
        userId: latest.userId,
        agentId: latest.currentAgent,
      },
      {
        type: 'outcome-marked',
        outcome: record.outcome,
        ...(record.reason ? { reason: record.reason } : {}),
        markedBy: record.markedBy,
      },
    );
  });

  session.metadata = saved.metadata;
  session.updatedAt = saved.updatedAt;
  session.version = saved.version;

  if (emit) {
    emit({
      channel: 'client',
      type: 'conversation-outcome',
      payload: { outcome: record.outcome },
    });
  }

  return record;
}
