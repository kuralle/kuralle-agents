import type { AuditListOptions, ConversationAuditEntry } from '../audit/types.js';
import type { ConversationOutcome, ConversationOutcomeMarkedBy } from '../outcomes/types.js';
import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { TurnHandle } from '../types/stream.js';
import type { RunOptions } from './Runtime.js';

export interface RuntimeLike {
  run(opts: RunOptions): TurnHandle;
  stream(opts: RunOptions): TurnHandle;
  getSession(sessionId: string): Promise<Session | null>;
  getSessionStore(): SessionStore;
  deleteSession(sessionId: string): Promise<void>;
  abortSession(sessionId: string, reason?: string): void;
  replayAuditLog(
    sessionId: string,
    opts?: AuditListOptions,
  ): Promise<ConversationAuditEntry[]>;
  markOutcome(
    sessionId: string,
    outcome: ConversationOutcome,
    opts?: { reason?: string; markedBy?: ConversationOutcomeMarkedBy },
  ): Promise<void>;
  getConversationLength?(sessionId: string): Promise<number>;
  compressNow?(
    sessionId: string,
    opts?: { focusTopic?: string; force?: boolean },
  ): Promise<Record<string, unknown>>;
}
