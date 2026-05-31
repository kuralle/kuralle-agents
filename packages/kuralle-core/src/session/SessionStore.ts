import type { Session } from '../types/index.js';
import type { AuditListOptions, ConversationAuditEntry } from '../audit/types.js';

export interface SessionListWindow {
  from?: Date;
  to?: Date;
}

export interface SessionStore {
  get(id: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  list(userId?: string): Promise<Session[]>;
  listSessions?(window?: SessionListWindow, filter?: (session: Session) => boolean): Promise<Session[]>;
  cleanup?(maxAgeMs: number): Promise<number>;
  appendAuditEntry?(sessionId: string, entry: ConversationAuditEntry): Promise<void>;
  listAuditEntries?(sessionId: string, opts?: AuditListOptions): Promise<ConversationAuditEntry[]>;
}
