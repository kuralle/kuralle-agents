import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createMemoryMcpConnectionStore,
  createSqliteMcpConnectionStore,
} from '../src/index.js';
import type { McpSqlStorage } from '../src/index.js';

/**
 * `SQLITE_SCHEMA` is a `CREATE TABLE IF NOT EXISTS`, so it does nothing at all against a
 * Durable Object that already has the old four-column table. Adding the `tools` column to
 * the schema string alone would leave every existing DO on the old shape, and every INSERT
 * naming `tools` would fail — schema drift a deployment discovers, not a test.
 *
 * `bun:sqlite` stands in for DO SQLite here. The workerd suite covers the real backend;
 * what this pins is the migration, which a fresh DO can never exercise.
 */

const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('streamable-http', 'sse')),
  url TEXT NOT NULL
);
`;

function sqlStorage(db: Database): McpSqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]) {
      return db.query(query).all(...(bindings as never[])) as Record<
        string,
        unknown
      >[];
    },
  };
}

const SERVER = {
  id: 'stub',
  name: 'stub',
  type: 'streamable-http' as const,
  url: 'https://stub.invalid/mcp',
  tools: [
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } },
  ],
};

describe('the SQLite connection store', () => {
  it('adds the tools column to a table created before it existed', () => {
    const db = new Database(':memory:');
    db.run(OLD_SCHEMA);
    db.run(
      "INSERT INTO mcp_servers (id, name, type, url) VALUES ('stub', 'stub', 'streamable-http', 'https://stub.invalid/mcp')",
    );

    const store = createSqliteMcpConnectionStore(sqlStorage(db));

    const columns = db
      .query('PRAGMA table_info(mcp_servers)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('tools');

    // The pre-existing row survives the migration and simply has no cached listing yet.
    return store.list().then((rows) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tools).toBeUndefined();
    });
  });

  it('round-trips a cached listing through storage', async () => {
    const db = new Database(':memory:');
    const store = createSqliteMcpConnectionStore(sqlStorage(db));

    await store.save(SERVER);
    const [row] = await store.list();

    expect(row!.tools).toEqual(SERVER.tools);
  });

  it('drops a listing it cannot parse rather than stranding the server', async () => {
    // The listing is a cache. Losing it costs one `tools/list` on the next wake; throwing
    // would strand a Durable Object that could otherwise reconnect perfectly well.
    const db = new Database(':memory:');
    const store = createSqliteMcpConnectionStore(sqlStorage(db));
    await store.save(SERVER);
    db.run("UPDATE mcp_servers SET tools = '{ not json'");

    const [row] = await store.list();

    expect(row!.name).toBe('stub');
    expect(row!.tools).toBeUndefined();
  });

  it('never persists a field nobody declared, whichever store is used', async () => {
    // Rebuilt from named fields rather than copied, so a caller that smuggles an extra
    // key past the type system cannot get it written down.
    const smuggled = { ...SERVER, headers: { Authorization: 'Bearer LEAK' } };

    const memory = createMemoryMcpConnectionStore();
    await memory.save(smuggled);
    expect(JSON.stringify(await memory.list())).not.toContain('LEAK');

    const db = new Database(':memory:');
    const sqlite = createSqliteMcpConnectionStore(sqlStorage(db));
    await sqlite.save(smuggled);
    expect(JSON.stringify(await sqlite.list())).not.toContain('LEAK');
  });
});
