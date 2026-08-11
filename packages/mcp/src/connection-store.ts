// Reimplemented from `cloudflare/agents`, `packages/agents/src/mcp/client-storage.ts`
// (MIT). Reimplemented from the described design, not copied; changes were made.

/** Minimal structural shape of a DO `ctx.storage.sql`. Structural, so a real one fits. */
export interface McpSqlStorage {
  exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
}

/**
 * A remote tool as the server published it. Public catalogue metadata — the same text the
 * model is shown in its prompt — and therefore persistable. The credential rule below is
 * unchanged by its presence: this is what the server advertises, never what authenticates
 * to it.
 */
export interface PersistedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Serialisable subset of a connected remote MCP server — the only fields that may persist. */
export interface PersistedServer {
  id: string;
  name: string;
  type: 'streamable-http' | 'sse';
  url: string;
  /** Last known `tools/list` result, so a wake can project before it re-lists. */
  tools?: readonly PersistedTool[];
}

export interface McpConnectionStore {
  list(): Promise<readonly PersistedServer[]>;
  save(server: PersistedServer): Promise<void>;
  remove(id: string): Promise<void>;
}

const PERSISTED_KEYS = ['id', 'name', 'type', 'url', 'tools'] as const;

/**
 * Rebuilds the row from named fields rather than copying the caller's object, so a field
 * nobody declared cannot ride along. The key loop then fails loudly if this function and
 * `PERSISTED_KEYS` ever disagree about what "declared" means.
 */
function assertPersistedShape(server: PersistedServer): PersistedServer {
  const row: PersistedServer = {
    id: server.id,
    name: server.name,
    type: server.type,
    url: server.url,
  };
  if (server.tools !== undefined) {
    row.tools = server.tools.map((tool) => {
      const persisted: PersistedTool = { name: tool.name };
      if (tool.description !== undefined) {
        persisted.description = tool.description;
      }
      if (tool.inputSchema !== undefined) {
        persisted.inputSchema = tool.inputSchema;
      }
      return persisted;
    });
  }
  for (const key of Object.keys(row)) {
    if (!(PERSISTED_KEYS as readonly string[]).includes(key)) {
      throw new Error(`McpConnectionStore: unexpected field "${key}"`);
    }
  }
  if (server.type !== 'streamable-http' && server.type !== 'sse') {
    throw new Error(`McpConnectionStore: unsupported type "${server.type}"`);
  }
  return row;
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
  url TEXT NOT NULL,
  tools TEXT
);
`;

/**
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a Durable Object that already has the
 * four-column table, so a new column has to be added explicitly. Without this, an existing
 * DO would keep its old table and every `INSERT` naming `tools` would fail — the schema
 * drift a deployment discovers rather than a test.
 */
function ensureToolsColumn(sql: McpSqlStorage): void {
  const columns = [...sql.exec('PRAGMA table_info(mcp_servers)')];
  if (columns.some((column) => String(column.name) === 'tools')) {
    return;
  }
  sql.exec('ALTER TABLE mcp_servers ADD COLUMN tools TEXT');
}

/**
 * A stored listing that no longer parses is dropped, not thrown. It is a cache: losing it
 * costs one `tools/list` on the next wake, while throwing would strand a Durable Object
 * that could otherwise reconnect perfectly well.
 */
function decodeTools(value: unknown): PersistedTool[] | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const tools: PersistedTool[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { name?: unknown }).name !== 'string'
    ) {
      return undefined;
    }
    tools.push(entry as PersistedTool);
  }
  return tools;
}

function rowToPersisted(record: Record<string, unknown>): PersistedServer {
  const tools = decodeTools(record.tools);
  return assertPersistedShape({
    id: String(record.id),
    name: String(record.name),
    type: record.type as PersistedServer['type'],
    url: String(record.url),
    ...(tools ? { tools } : {}),
  });
}

export function createSqliteMcpConnectionStore(sql: McpSqlStorage): McpConnectionStore {
  sql.exec(SQLITE_SCHEMA);
  ensureToolsColumn(sql);

  return {
    async list() {
      const records = [...sql.exec('SELECT id, name, type, url, tools FROM mcp_servers')];
      return records.map(rowToPersisted);
    },
    async save(server) {
      const row = assertPersistedShape(server);
      sql.exec(
        `INSERT INTO mcp_servers (id, name, type, url, tools) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
           url = excluded.url, tools = excluded.tools`,
        row.id,
        row.name,
        row.type,
        row.url,
        row.tools === undefined ? null : JSON.stringify(row.tools),
      );
    },
    async remove(id) {
      sql.exec('DELETE FROM mcp_servers WHERE id = ?', id);
    },
  };
}
