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
  /**
   * Trust baseline for remote tool drift detection. Written once when absent; reconcile refreshes
   * `tools` but must never rewrite this — both stores below drop an incoming baseline when one is
   * already recorded, so a compromised catalogue cannot become the trusted one by being saved again.
   *
   * That also means `save()` alone cannot re-trust a server. Re-trusting is deliberately a two-step
   * operator action: `remove(id)` then `save(row)`. There is no UI for it yet.
   */
  toolFingerprints?: Record<string, string>;
}

export interface McpConnectionStore {
  list(): Promise<readonly PersistedServer[]>;
  save(server: PersistedServer): Promise<void>;
  remove(id: string): Promise<void>;
}

const PERSISTED_KEYS = ['id', 'name', 'type', 'url', 'tools', 'toolFingerprints'] as const;

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
  if (server.toolFingerprints !== undefined) {
    row.toolFingerprints = { ...server.toolFingerprints };
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
      const existing = rows.get(row.id);
      // Once a baseline is recorded it stands, whatever the caller passes — the same rule the
      // SQLite store enforces with COALESCE. Preserving it only when the incoming value is
      // undefined would let a caller replace a trusted baseline here but not on Cloudflare,
      // which is a security property differing by backend.
      if (existing?.toolFingerprints !== undefined) {
        row.toolFingerprints = existing.toolFingerprints;
      }
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
  tools TEXT,
  tool_fingerprints TEXT
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

function ensureToolFingerprintsColumn(sql: McpSqlStorage): void {
  const columns = [...sql.exec('PRAGMA table_info(mcp_servers)')];
  if (columns.some((column) => String(column.name) === 'tool_fingerprints')) {
    return;
  }
  sql.exec('ALTER TABLE mcp_servers ADD COLUMN tool_fingerprints TEXT');
}

/**
 * A stored listing that no longer parses is dropped, not thrown. It is a cache: losing it
 * costs one `tools/list` on the next wake, while throwing would strand a Durable Object
 * that could otherwise reconnect perfectly well.
 */
function decodeToolFingerprints(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const fingerprints: Record<string, string> = {};
  for (const [name, digest] of Object.entries(parsed)) {
    if (typeof digest !== 'string') {
      return undefined;
    }
    fingerprints[name] = digest;
  }
  return fingerprints;
}

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
  const toolFingerprints = decodeToolFingerprints(record.tool_fingerprints);
  return assertPersistedShape({
    id: String(record.id),
    name: String(record.name),
    type: record.type as PersistedServer['type'],
    url: String(record.url),
    ...(tools ? { tools } : {}),
    ...(toolFingerprints ? { toolFingerprints } : {}),
  });
}

export function createSqliteMcpConnectionStore(sql: McpSqlStorage): McpConnectionStore {
  sql.exec(SQLITE_SCHEMA);
  ensureToolsColumn(sql);
  ensureToolFingerprintsColumn(sql);

  return {
    async list() {
      const records = [
        ...sql.exec('SELECT id, name, type, url, tools, tool_fingerprints FROM mcp_servers'),
      ];
      return records.map(rowToPersisted);
    },
    async save(server) {
      const row = assertPersistedShape(server);
      sql.exec(
        `INSERT INTO mcp_servers (id, name, type, url, tools, tool_fingerprints)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
           url = excluded.url, tools = excluded.tools,
           tool_fingerprints = COALESCE(mcp_servers.tool_fingerprints, excluded.tool_fingerprints)`,
        row.id,
        row.name,
        row.type,
        row.url,
        row.tools === undefined ? null : JSON.stringify(row.tools),
        row.toolFingerprints === undefined ? null : JSON.stringify(row.toolFingerprints),
      );
    },
    async remove(id) {
      sql.exec('DELETE FROM mcp_servers WHERE id = ?', id);
    },
  };
}
