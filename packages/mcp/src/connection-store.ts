// Reimplemented from `cloudflare/agents`, `packages/agents/src/mcp/client-storage.ts`
// (MIT). Reimplemented from the described design, not copied; changes were made.

/** Minimal structural shape of a DO `ctx.storage.sql`. Structural, so a real one fits. */
export interface McpSqlStorage {
  exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
}

/** Serialisable subset of a connected remote MCP server — the only fields that may persist. */
export interface PersistedServer {
  id: string;
  name: string;
  type: 'streamable-http' | 'sse';
  url: string;
}

export interface McpConnectionStore {
  list(): Promise<readonly PersistedServer[]>;
  save(server: PersistedServer): Promise<void>;
  remove(id: string): Promise<void>;
}

const PERSISTED_KEYS = ['id', 'name', 'type', 'url'] as const;

function assertPersistedShape(server: PersistedServer): PersistedServer {
  const row: Record<string, unknown> = {
    id: server.id,
    name: server.name,
    type: server.type,
    url: server.url,
  };
  for (const key of Object.keys(row)) {
    if (!(PERSISTED_KEYS as readonly string[]).includes(key)) {
      throw new Error(`McpConnectionStore: unexpected field "${key}"`);
    }
  }
  if (server.type !== 'streamable-http' && server.type !== 'sse') {
    throw new Error(`McpConnectionStore: unsupported type "${server.type}"`);
  }
  return server;
}

export function createMemoryMcpConnectionStore(): McpConnectionStore {
  const rows = new Map<string, PersistedServer>();

  return {
    async list() {
      return [...rows.values()];
    },
    async save(server) {
      const row = assertPersistedShape(server);
      rows.set(row.id, row);
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('streamable-http', 'sse')),
  url TEXT NOT NULL
);
`;

function rowToPersisted(record: Record<string, unknown>): PersistedServer {
  return assertPersistedShape({
    id: String(record.id),
    name: String(record.name),
    type: record.type as PersistedServer['type'],
    url: String(record.url),
  });
}

export function createSqliteMcpConnectionStore(sql: McpSqlStorage): McpConnectionStore {
  sql.exec(SQLITE_SCHEMA);

  return {
    async list() {
      const records = [...sql.exec('SELECT id, name, type, url FROM mcp_servers')];
      return records.map(rowToPersisted);
    },
    async save(server) {
      const row = assertPersistedShape(server);
      sql.exec(
        `INSERT INTO mcp_servers (id, name, type, url) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, url = excluded.url`,
        row.id,
        row.name,
        row.type,
        row.url,
      );
    },
    async remove(id) {
      sql.exec('DELETE FROM mcp_servers WHERE id = ?', id);
    },
  };
}
