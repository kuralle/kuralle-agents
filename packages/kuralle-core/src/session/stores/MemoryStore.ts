import type { Session } from '../../types/index.js';
import type { AuditListOptions, ConversationAuditEntry } from '../../audit/types.js';
import type { SessionListWindow, SessionStore } from '../SessionStore.js';

export class MemoryStore implements SessionStore {
  private sessions = new Map<string, Session>();

  async get(id: string): Promise<Session | null> {
    const session = this.sessions.get(id);
    return session ? safeClone(session) : null;
  }

  async save(session: Session): Promise<void> {
    session.updatedAt = new Date();
    this.sessions.set(session.id, safeClone(session));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async list(userId?: string): Promise<Session[]> {
    const all = Array.from(this.sessions.values()).map(s => safeClone(s));
    if (userId) {
      return all.filter(session => session.userId === userId);
    }
    return all;
  }

  async listSessions(window?: SessionListWindow, filter?: (session: Session) => boolean): Promise<Session[]> {
    return (await this.list())
      .filter(session => isSessionInWindow(session, window))
      .filter(session => filter ? filter(session) : true);
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    const now = Date.now();
    let deleted = 0;

    for (const [id, session] of this.sessions) {
      const age = now - session.updatedAt.getTime();
      if (age > maxAgeMs) {
        this.sessions.delete(id);
        deleted += 1;
      }
    }

    return deleted;
  }

  async listAuditEntries(sessionId: string, opts: AuditListOptions = {}): Promise<ConversationAuditEntry[]> {
    const session = await this.get(sessionId);
    return filterAuditEntries(session?.metadata?.audit ?? [], opts);
  }
}

function isSessionInWindow(session: Session, window?: SessionListWindow): boolean {
  if (!window?.from && !window?.to) return true;
  const timestamp = session.metadata?.outcome?.markedAt
    ? new Date(session.metadata.outcome.markedAt).getTime()
    : session.updatedAt.getTime();
  if (Number.isNaN(timestamp)) return false;
  if (window.from && timestamp < window.from.getTime()) return false;
  if (window.to && timestamp > window.to.getTime()) return false;
  return true;
}

function filterAuditEntries(
  entries: ConversationAuditEntry[],
  opts: AuditListOptions,
): ConversationAuditEntry[] {
  const types = opts.types && opts.types.length > 0 ? new Set(opts.types) : undefined;
  const from = opts.from?.getTime();
  const to = opts.to?.getTime();

  return entries
    .filter((entry) => !types || types.has(entry.type))
    .filter((entry) => {
      const at = Date.parse(entry.at);
      if (Number.isNaN(at)) return false;
      if (from !== undefined && at < from) return false;
      if (to !== undefined && at > to) return false;
      return true;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Deep clone a session object. Tries structuredClone first (preserves Dates,
 * Maps, etc.), falls back to JSON round-trip if the session contains
 * non-cloneable values like Promises or Functions (can happen when AI SDK
 * tool results or pending operations are stored in session state).
 */
function safeClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value, (_key, val) => {
      if (typeof val === 'function' || val instanceof Promise) return undefined;
      return val;
    }));
  }
}
