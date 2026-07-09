/**
 * kuralle-fs demo on Vercel (Node serverless) — a PERSISTENT workspace filesystem.
 *
 * Vercel functions are stateless (no durable local disk), so persistence needs an
 * external store. This uses `sqlFileSystem` over Turso (libSQL — SQLite-compatible,
 * so the SqlFileSystem SQL runs unchanged) via the fetch-based web client. It's the
 * same platform-chosen backend story as Cloudflare, where the handle is a Durable
 * Object's ctx.storage.sql instead.
 *
 *   POST /api/write   { "path": "/kb/a.md", "content": "..." }
 *   GET  /api/read?path=/kb/a.md      -> read (persisted in Turso across requests)
 *   GET  /api/ls?path=/kb
 *   GET  /api/concepts                -> OKF concept graph over the persistent fs
 *   GET  /                            -> demo page
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@libsql/client/web';
import {
  InMemoryFs,
  sqlFileSystem,
  listOkfConcepts,
  type SqlBackend,
  type FileSystem,
} from '@kuralle-agents/fs';

// libSQL (Turso) as a two-method SqlBackend. Rows come back keyed by column name.
function libsqlBackend(url: string, authToken: string): SqlBackend {
  const client = createClient({ url, authToken });
  return {
    query: async (sql, ...args) =>
      (await client.execute({ sql, args: args as never })).rows as never,
    run: async (sql, ...args) => {
      await client.execute({ sql, args: args as never });
    },
  };
}

function workspace(): { fs: FileSystem; persistent: boolean } {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (url && token) return { fs: sqlFileSystem(libsqlBackend(url, token)), persistent: true };
  // Fallback for local dev without Turso creds — ephemeral.
  return { fs: new InMemoryFs(), persistent: false };
}

const PAGE = `<!doctype html><meta charset=utf-8><title>kuralle-fs on Vercel</title>
<style>body{font:15px/1.5 system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem}code,pre{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}pre{padding:1rem;overflow:auto}</style>
<h1>kuralle-fs — persistent workspace on Vercel (Turso / libSQL)</h1>
<p>A <code>SqlFileSystem</code> over a hosted Turso database. Vercel functions are
stateless, so persistence lives in Turso — files written in one request survive for
the next. Same backend story as Cloudflare, where the handle is a Durable Object's
<code>ctx.storage.sql</code>.</p>
<pre>curl -X POST "$URL/api/write" -H 'content-type: application/json' -d '{"path":"/kb/hours.md","content":"Open 9-5"}'
curl "$URL/api/read?path=/kb/hours.md"    # persisted in Turso
curl "$URL/api/ls?path=/kb"</pre>`;

const OKF: Record<string, string> = {
  '/index.md': '# Sales\n* [Orders](/tables/orders.md)\n* [WAU](/metrics/wau.md)',
  '/tables/orders.md': '---\ntype: BigQuery Table\ntitle: Orders\ndescription: One row per order.\n---\n# Schema\norder_id, customer_id.',
  '/metrics/wau.md': '---\ntype: Metric\ntitle: Weekly Active Users\ndescription: Distinct users in 7 days.\n---\n# Definition\nCOUNT(DISTINCT user_id) over events.',
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (data: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data, null, 2));
  };

  if (url.pathname === '/' || url.pathname === '') {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE.replaceAll('$URL', `https://${req.headers.host ?? ''}`));
    return;
  }

  try {
    const { fs, persistent } = workspace();

    if (url.pathname === '/api/write' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const { path, content } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!path || content === undefined) return send({ error: 'path and content required' }, 400);
      const dir = String(path).replace(/\/[^/]*$/, '') || '/';
      if (dir !== '/') await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, content);
      return send({ ok: true, persistent, wrote: path, bytes: String(content).length });
    }
    if (url.pathname === '/api/read') {
      const path = url.searchParams.get('path');
      if (!path) return send({ error: 'path required' }, 400);
      return send({ path, persistent, content: await fs.readFile(path) });
    }
    if (url.pathname === '/api/ls') {
      const path = url.searchParams.get('path') ?? '/';
      return send({ path, persistent, entries: await fs.readdir(path) });
    }
    if (url.pathname === '/api/concepts') {
      const okfFs = new InMemoryFs(OKF);
      return send({ concepts: await listOkfConcepts(okfFs) });
    }
  } catch (err) {
    return send({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
  send({ error: 'not found' }, 404);
}
