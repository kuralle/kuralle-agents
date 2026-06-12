import type { Session, SessionStore } from '@kuralle-agents/core';

/**
 * Minimal DO-SQLite SessionStore: persists the whole Session as a JSON row.
 *
 * The durable run journal (`session.durableRuns`) is a plain property, so it is
 * serialized with the rest of the session — that's what gives suspend/resume +
 * exactly-once across DO eviction (a `/wa-pay` click can land on a cold DO).
 *
 * Dates (`createdAt`/`updatedAt`/handoff timestamps) don't survive JSON, so we
 * revive them on read — same approach the framework's BridgeSessionStore takes.
 */
type SqlLike = {
  exec: (query: string, ...bindings: unknown[]) => { toArray: () => Array<Record<string, unknown>> };
};

function revive(session: Session): Session {
  session.createdAt = new Date(session.createdAt as unknown as string);
  session.updatedAt = new Date(session.updatedAt as unknown as string);
  for (const h of session.handoffHistory ?? []) {
    const rec = h as unknown as { timestamp: unknown };
    rec.timestamp = new Date(rec.timestamp as string);
  }
  const meta = (session as { metadata?: { createdAt?: unknown; lastActiveAt?: unknown } }).metadata;
  if (meta) {
    if (meta.createdAt) meta.createdAt = new Date(meta.createdAt as string);
    if (meta.lastActiveAt) meta.lastActiveAt = new Date(meta.lastActiveAt as string);
  }
  return session;
}

export class SqlSessionStore implements SessionStore {
  constructor(private readonly sql: SqlLike) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  }

  async get(id: string): Promise<Session | null> {
    const rows = this.sql.exec('SELECT data FROM sessions WHERE id = ?', id).toArray();
    if (rows.length === 0) return null;
    return revive(JSON.parse(rows[0].data as string) as Session);
  }

  async save(session: Session): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO sessions (id, data) VALUES (?, ?)',
      session.id,
      JSON.stringify(session),
    );
  }

  async delete(id: string): Promise<void> {
    this.sql.exec('DELETE FROM sessions WHERE id = ?', id);
  }

  async list(): Promise<Session[]> {
    return this.sql
      .exec('SELECT data FROM sessions')
      .toArray()
      .map((r) => revive(JSON.parse(r.data as string) as Session));
  }
}
