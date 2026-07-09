/**
 * kuralle-fs demo on Cloudflare — a PERSISTENT workspace on Durable Object SQLite.
 *
 * The Durable Object holds a `SqlFileSystem` over its own `ctx.storage.sql`, so
 * files written in one request survive for the next (and across DO restarts) —
 * the exact ghost-writes fix, on real Cloudflare infra. No external DB, no LLM.
 *
 *   POST /fs/write   { "path": "/kb/a.md", "content": "..." }
 *   GET  /fs/read?path=/kb/a.md
 *   GET  /fs/ls?path=/kb
 *   GET  /                      -> demo page
 */
import { DurableObject } from 'cloudflare:workers';
import { sqlFileSystem } from '@kuralle-agents/fs';
import type { FileSystem } from '@kuralle-agents/core';

interface Env {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
}

export class WorkspaceDO extends DurableObject {
  private fs: FileSystem;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Persistent workspace over this DO's SQLite. Auto-detected from the handle.
    this.fs = sqlFileSystem(ctx.storage.sql);
  }

  async write(path: string, content: string): Promise<void> {
    const dir = path.replace(/\/[^/]*$/, '') || '/';
    if (dir !== '/') await this.fs.mkdir(dir, { recursive: true });
    await this.fs.writeFile(path, content);
  }

  async read(path: string): Promise<string> {
    return this.fs.readFile(path);
  }

  async ls(path: string): Promise<string[]> {
    return this.fs.readdir(path);
  }
}

const PAGE = `<!doctype html><meta charset=utf-8><title>kuralle-fs on Cloudflare</title>
<style>body{font:15px/1.5 system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem}code,pre{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}pre{padding:1rem;overflow:auto}</style>
<h1>kuralle-fs — persistent workspace on Durable Object SQLite</h1>
<p>A <code>SqlFileSystem</code> backed by this Durable Object's <code>ctx.storage.sql</code>.
Files written in one request are read back in another — persistence on real Cloudflare infra.</p>
<pre># write, then read it back in a separate request:
curl -X POST "$URL/fs/write" -H 'content-type: application/json' -d '{"path":"/kb/hours.md","content":"Open 9-5"}'
curl "$URL/fs/read?path=/kb/hours.md"
curl "$URL/fs/ls?path=/kb"</pre>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(PAGE.replaceAll('$URL', url.origin), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName('demo'));
    try {
      if (url.pathname === '/fs/write' && req.method === 'POST') {
        const { path, content } = (await req.json()) as { path?: string; content?: string };
        if (!path || content === undefined) return json({ error: 'path and content required' }, 400);
        await stub.write(path, content);
        return json({ ok: true, wrote: path, bytes: content.length });
      }
      if (url.pathname === '/fs/read') {
        const path = url.searchParams.get('path');
        if (!path) return json({ error: 'path required' }, 400);
        return json({ path, content: await stub.read(path) });
      }
      if (url.pathname === '/fs/ls') {
        const path = url.searchParams.get('path') ?? '/';
        return json({ path, entries: await stub.ls(path) });
      }
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    return json({ error: 'not found' }, 404);
  },
};
