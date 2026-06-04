import type { ConversationAuditEntry, AuditEntryBase } from './types.js';
import type { Session } from '../types/session.js';

export interface AuditRecordContext {
  sessionId: string;
  conversationId?: string;
  userId?: string;
  agentId?: string;
  turnIndex?: number;
}

export type NewAuditEntry = {
  [K in ConversationAuditEntry['type']]: Omit<
    Extract<ConversationAuditEntry, { type: K }>,
    keyof AuditEntryBase
  >;
}[ConversationAuditEntry['type']];

export function appendConversationAudit(session: Session, ctx: AuditRecordContext, entry: NewAuditEntry): void {
  const at = new Date().toISOString();
  const full = {
    at,
    sessionId: ctx.sessionId,
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    turnIndex: ctx.turnIndex,
    ...entry,
  } as ConversationAuditEntry;

  if (!session.metadata) {
    session.metadata = {
      createdAt: session.createdAt,
      lastActiveAt: session.updatedAt,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    };
  }
  session.metadata.audit ??= [];
  session.metadata.audit.push(full);
}
