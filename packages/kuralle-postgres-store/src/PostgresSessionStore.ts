import type { AuditListOptions, ConversationAuditEntry, Session, SessionStore } from '@kuralle-agents/core';
import type { QueryResult } from 'pg';

type PostgresClient = {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
};

export type PostgresStoreOptions = {
  client: PostgresClient;
  tableName?: string;
  auditTableName?: string;
  autoMigrate?: boolean;
};

const defaultTable = 'kuralle_sessions';
const defaultAuditTable = 'audit_entries';

const reviveSession = (raw: Session): Session => {
  const session = { ...raw } as Session;
  session.conversationId = session.conversationId ?? session.id;
  session.channelId = session.channelId ?? 'web';
  session.createdAt = new Date(session.createdAt);
  session.updatedAt = new Date(session.updatedAt);
  session.handoffHistory = (session.handoffHistory ?? []).map(record => ({
    ...record,
    timestamp: new Date(record.timestamp),
  }));
  if (session.metadata) {
    session.metadata = {
      ...session.metadata,
      createdAt: new Date(session.metadata.createdAt),
      lastActiveAt: new Date(session.metadata.lastActiveAt),
      handoffHistory: (session.metadata.handoffHistory ?? []).map(record => ({
        ...record,
        timestamp: new Date(record.timestamp),
      })),
    };
  }
  session.agentStates = Object.fromEntries(
    Object.entries(session.agentStates ?? {}).map(([agentId, state]) => [
      agentId,
      {
        ...state,
        lastActive: new Date(state.lastActive),
      },
    ])
  );
  return session;
};

const normalizeTableName = (tableName?: string): string => {
  const table = tableName ?? defaultTable;
  if (!/^[a-zA-Z0-9_.]+$/.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  return table;
};

export class PostgresSessionStore implements SessionStore {
  private client: PostgresClient;
  private table: string;
  private auditTable: string;
  private ready: Promise<void>;

  constructor(options: PostgresStoreOptions) {
    this.client = options.client;
    this.table = normalizeTableName(options.tableName);
    this.auditTable = normalizeTableName(options.auditTableName ?? defaultAuditTable);
    const autoMigrate = options.autoMigrate ?? true;
    this.ready = autoMigrate ? this.init() : Promise.resolve();
  }

  private async init(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        conversation_id TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL DEFAULT 'web',
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    await this.client.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS conversation_id TEXT NOT NULL DEFAULT ''`);
    await this.client.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS channel_id TEXT NOT NULL DEFAULT 'web'`);
    await this.client.query(`UPDATE ${this.table} SET conversation_id = id WHERE conversation_id = ''`);
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${this.table.replace(/\./g, '_')}_conversation_idx ON ${this.table} (user_id, channel_id, conversation_id)`
    );
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.auditTable} (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE,
        at TIMESTAMPTZ NOT NULL,
        type TEXT NOT NULL,
        payload JSONB NOT NULL
      )`
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${this.auditTable.replace(/\./g, '_')}_session_at_idx ON ${this.auditTable} (session_id, at)`
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${this.auditTable.replace(/\./g, '_')}_session_type_idx ON ${this.auditTable} (session_id, type)`
    );
  }

  async get(id: string): Promise<Session | null> {
    await this.ready;
    const result = await this.client.query(
      `SELECT data FROM ${this.table} WHERE id = $1`,
      [id]
    );

    if (!result.rows.length) {
      return null;
    }

    const raw = result.rows[0]?.data;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return reviveSession(parsed as Session);
    } catch (error) {
      console.error('Failed to parse session data from Postgres', error);
      return null;
    }
  }

  async save(session: Session): Promise<void> {
    await this.ready;
    session.updatedAt = new Date();
    session.conversationId = session.conversationId ?? session.id;
    session.channelId = session.channelId ?? 'web';
    const data = JSON.stringify(session);

    await this.client.query(
      `INSERT INTO ${this.table} (id, user_id, conversation_id, channel_id, data, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, user_id = EXCLUDED.user_id, conversation_id = EXCLUDED.conversation_id, channel_id = EXCLUDED.channel_id, updated_at = NOW()`,
      [session.id, session.userId ?? null, session.conversationId, session.channelId, data]
    );
  }

  async delete(id: string): Promise<void> {
    await this.ready;
    await this.client.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  async list(userId?: string): Promise<Session[]> {
    await this.ready;
    const result = userId
      ? await this.client.query(`SELECT data FROM ${this.table} WHERE user_id = $1`, [userId])
      : await this.client.query(`SELECT data FROM ${this.table}`);

    return result.rows
      .map((row: { data: unknown }) => {
        try {
          const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          return reviveSession(parsed as Session);
        } catch {
          return null;
        }
      })
      .filter((session: Session | null): session is Session => session !== null);
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    await this.ready;
    const cutoff = new Date(Date.now() - maxAgeMs);
    const result = await this.client.query(
      `DELETE FROM ${this.table} WHERE updated_at < $1`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }

  async appendAuditEntry(sessionId: string, entry: ConversationAuditEntry): Promise<void> {
    await this.ready;
    await this.client.query(
      `INSERT INTO ${this.auditTable} (session_id, at, type, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [sessionId, new Date(entry.at), entry.type, JSON.stringify(entry)]
    );
  }

  async listAuditEntries(sessionId: string, opts: AuditListOptions = {}): Promise<ConversationAuditEntry[]> {
    await this.ready;
    const clauses = ['session_id = $1'];
    const params: unknown[] = [sessionId];

    if (opts.from) {
      params.push(opts.from);
      clauses.push(`at >= $${params.length}`);
    }
    if (opts.to) {
      params.push(opts.to);
      clauses.push(`at <= $${params.length}`);
    }
    if (opts.types && opts.types.length > 0) {
      params.push(opts.types);
      clauses.push(`type = ANY($${params.length}::text[])`);
    }

    const result = await this.client.query(
      `SELECT payload FROM ${this.auditTable}
       WHERE ${clauses.join(' AND ')}
       ORDER BY at ASC, id ASC`,
      params
    );

    return result.rows
      .map((row: { payload: unknown }) => {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        return payload as ConversationAuditEntry;
      });
  }
}
