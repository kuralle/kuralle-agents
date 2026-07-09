import { describe, expect, it } from 'bun:test';
import { libsqlHttpBackend } from '../src/index.js';
import { SqlFileSystem } from '../src/sql/sql-fs.js';

// A fake libSQL HTTP server backed by an in-memory table map, exercising the
// /v2/pipeline request/response shape (cols + typed cells).
function fakeLibsqlFetch() {
  const rows: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const fetch = (async (_url: string, init: { body: string }) => {
    const { requests } = JSON.parse(init.body);
    const { sql, args } = requests[0].stmt;
    calls.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
    // Minimal SQL interpreter: INSERT ... VALUES(?), SELECT * WHERE k=?
    let cols: { name: string }[] = [];
    let outRows: { type: string; value?: unknown }[][] = [];
    if (/^INSERT/i.test(sql)) {
      rows.push({ k: args[0].value, v: args[1].value });
    } else if (/^SELECT/i.test(sql)) {
      const key = args[0]?.value;
      const hit = rows.filter((r) => r.k === key);
      cols = [{ name: 'k' }, { name: 'v' }];
      outRows = hit.map((r) => [
        { type: 'text', value: r.k },
        { type: 'text', value: r.v },
      ]);
    }
    return {
      ok: true,
      json: async () => ({
        results: [{ type: 'ok', response: { result: { cols, rows: outRows } } }, { type: 'ok' }],
      }),
    };
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

describe('libsqlHttpBackend', () => {
  it('maps typed cells to plain rows and encodes args', async () => {
    const { fetch, calls } = fakeLibsqlFetch();
    const be = libsqlHttpBackend({ url: 'libsql://x.turso.io', authToken: 't', fetch });
    await be.run('INSERT INTO t(k,v) VALUES(?,?)', 'a', 'hello');
    const out = await be.query<{ k: string; v: string }>('SELECT * FROM t WHERE k=?', 'a');
    expect(out).toEqual([{ k: 'a', v: 'hello' }]);
    expect(calls[0]).toBe('INSERT INTO');
    expect(calls[1]).toBe('SELECT *');
  });

  it('normalizes libsql:// to https:// and sends a bearer token', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const fetch = (async (url: string, init: { headers: Record<string, string> }) => {
      seenUrl = url;
      seenAuth = init.headers.authorization;
      return { ok: true, json: async () => ({ results: [{ type: 'ok', response: { result: { cols: [], rows: [] } } }] }) };
    }) as unknown as typeof fetch;
    const be = libsqlHttpBackend({ url: 'libsql://db.turso.io/', authToken: 'secret', fetch });
    await be.run('SELECT 1');
    expect(seenUrl).toBe('https://db.turso.io/v2/pipeline');
    expect(seenAuth).toBe('Bearer secret');
  });

  it('surfaces server errors', async () => {
    const fetch = (async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })) as unknown as typeof fetch;
    const be = libsqlHttpBackend({ url: 'https://x', authToken: 'bad', fetch });
    await expect(be.run('SELECT 1')).rejects.toThrow(/401/);
  });
});
