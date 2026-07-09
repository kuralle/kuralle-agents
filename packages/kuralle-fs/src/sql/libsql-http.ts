// `libsqlHttpBackend` — a Turso / libSQL `SqlBackend` over the HTTP pipeline API,
// using ONLY `fetch`. No `@libsql/client`, so no native binary and no `ws` — it
// bundles cleanly for serverless (Vercel), Cloudflare Workers, and edge with no
// esbuild banner or platform-specific client. Zero `node:*`; Workers-clean.
//
//   sqlFileSystem(libsqlHttpBackend({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN }))
import type { SqlBackend, SqlParam } from './types.js';

export interface LibsqlHttpOptions {
  /** Turso database URL — `libsql://…` or `https://…` (both accepted). */
  url: string;
  authToken: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

interface Cell {
  type: 'null' | 'integer' | 'float' | 'text' | 'blob';
  value?: string | number;
  base64?: string;
}

function toCell(v: SqlParam): Cell {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  return { type: 'text', value: v };
}

function fromCell(c: Cell): SqlParam {
  switch (c.type) {
    case 'null':
      return null;
    case 'integer':
      return Number(c.value);
    case 'float':
      return typeof c.value === 'number' ? c.value : Number(c.value);
    case 'text':
    case 'blob':
      return String(c.value ?? c.base64 ?? '');
    default:
      return null;
  }
}

export function libsqlHttpBackend(opts: LibsqlHttpOptions): SqlBackend {
  const base = opts.url.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
  const doFetch = opts.fetch ?? fetch;

  async function pipeline(sql: string, args: SqlParam[]): Promise<{ cols: string[]; rows: Cell[][] }> {
    const res = await doFetch(`${base}/v2/pipeline`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.authToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          { type: 'execute', stmt: { sql, args: args.map(toCell) } },
          { type: 'close' },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`libsql HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      results: Array<{
        type: 'ok' | 'error';
        error?: { message: string };
        response?: { result?: { cols: Array<{ name: string }>; rows: Cell[][] } };
      }>;
    };
    const first = body.results[0];
    if (!first || first.type === 'error') {
      throw new Error(`libsql: ${first?.error?.message ?? 'unknown error'}`);
    }
    const result = first.response?.result ?? { cols: [], rows: [] };
    return { cols: result.cols.map((c) => c.name), rows: result.rows };
  }

  return {
    query: async <T = Record<string, SqlParam>>(sql: string, ...args: SqlParam[]): Promise<T[]> => {
      const { cols, rows } = await pipeline(sql, args);
      return rows.map((row) => {
        const obj: Record<string, SqlParam> = {};
        cols.forEach((name, i) => {
          obj[name] = fromCell(row[i] ?? { type: 'null' });
        });
        return obj as T;
      });
    },
    run: async (sql: string, ...args: SqlParam[]): Promise<void> => {
      await pipeline(sql, args);
    },
  };
}
