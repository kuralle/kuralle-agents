/**
 * kuralle-fs demo on Vercel (Node serverless) — a portable workspace filesystem
 * that consumes an Open Knowledge Format (OKF) bundle. Demonstrates ls / read /
 * grep and OKF concept navigation over `InMemoryFs`.
 *
 * Vercel functions are stateless (no persistent disk), so this uses an in-memory
 * workspace rebuilt per request. For PERSISTENCE on Vercel, point `sqlFileSystem`
 * at a hosted SQLite/SQL (Turso libSQL, Neon) — the same platform-chosen backend
 * story; on Cloudflare that handle is a Durable Object's ctx.storage.sql.
 *
 *   GET /api/concepts          -> OKF concept graph (id, type, description, links)
 *   GET /api/read?path=/x.md   -> read a file
 *   GET /api/grep?q=user_id    -> regex search across the bundle
 *   GET /                      -> demo page
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryFs, okfBundleToFs, listOkfConcepts } from '@kuralle-agents/fs';

const BUNDLE: Record<string, string> = {
  '/index.md': '# Sales\n* [Orders](/tables/orders.md) - one row per order.\n* [Events](/tables/events.md) - product events.\n* [WAU](/metrics/weekly_active_users.md) - the metric.',
  '/tables/orders.md':
    '---\ntype: BigQuery Table\ntitle: Orders\ndescription: One row per completed order.\ntags: [sales]\n---\n\n# Schema\n| Column | Type | Description |\n|---|---|---|\n| order_id | STRING | Unique id. |\n| customer_id | STRING | FK to [customers](/tables/customers.md). |',
  '/tables/events.md':
    '---\ntype: BigQuery Table\ntitle: Events\ndescription: Raw product event stream.\ntags: [product]\n---\n\n# Schema\nThe identity/join key for activity is `user_id`. Feeds [WAU](/metrics/weekly_active_users.md).',
  '/tables/customers.md':
    '---\ntype: BigQuery Table\ntitle: Customers\ndescription: One row per customer.\n---\n\n# Schema\ncustomer_id STRING.',
  '/metrics/weekly_active_users.md':
    '---\ntype: Metric\ntitle: Weekly Active Users\ndescription: Distinct users with an event in a 7-day window.\n---\n\n# Definition\nCOUNT(DISTINCT user_id) over [events](/tables/events.md), trailing 7-day window.',
};

const PAGE = `<!doctype html><meta charset=utf-8><title>kuralle-fs on Vercel</title>
<style>body{font:15px/1.5 system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem}code,pre{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}pre{padding:1rem;overflow:auto}</style>
<h1>kuralle-fs — portable workspace + OKF on Vercel</h1>
<p>An <code>InMemoryFs</code> workspace holding an Open Knowledge Format bundle, navigated with the same fs primitives that run on Node and Cloudflare.</p>
<pre>curl "$URL/api/concepts"
curl "$URL/api/read?path=/metrics/weekly_active_users.md"
curl "$URL/api/grep?q=user_id"</pre>
<p>Vercel functions are stateless; for persistence point <code>sqlFileSystem</code> at a hosted SQLite (Turso). On Cloudflare that handle is a Durable Object's <code>ctx.storage.sql</code>.</p>`;

async function grep(fs: InstanceType<typeof InMemoryFs>, q: string) {
  const re = new RegExp(q, 'i');
  const hits: Array<{ path: string; line: number; text: string }> = [];
  for (const path of await fs.glob('/**/*.md')) {
    const lines = (await fs.readFile(path)).split('\n');
    lines.forEach((text, i) => {
      if (re.test(text)) hits.push({ path, line: i + 1, text: text.slice(0, 120) });
    });
  }
  return hits;
}

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
    const fs = okfBundleToFs(BUNDLE) as InstanceType<typeof InMemoryFs>;
    if (url.pathname === '/api/concepts') {
      return send({ concepts: await listOkfConcepts(fs) });
    }
    if (url.pathname === '/api/read') {
      const path = url.searchParams.get('path');
      if (!path) return send({ error: 'path required' }, 400);
      return send({ path, content: await fs.readFile(path) });
    }
    if (url.pathname === '/api/grep') {
      const q = url.searchParams.get('q');
      if (!q) return send({ error: 'q required' }, 400);
      return send({ q, hits: await grep(fs, q) });
    }
  } catch (err) {
    return send({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
  send({ error: 'not found' }, 404);
}

// InMemoryFs is used for type inference above; keep the import referenced.
void InMemoryFs;
