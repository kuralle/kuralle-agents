/**
 * kuralle-fs demo on Cloudflare — a PERSISTENT workspace hosted by a cf-agent
 * (`KuralleAgent`) Durable Object. The agent's `workspace` is a `SqlFileSystem`
 * over the DO's own `ctx.storage.sql`, so the model's files (and everything the
 * fs tool writes) survive across turns and restarts — the ghost-writes fix, on
 * real Cloudflare infra, through the cf-agent runtime.
 *
 *   POST /fs/write   { "path": "/kb/a.md", "content": "..." }
 *   GET  /fs/read?path=/kb/a.md
 *   GET  /fs/ls?path=/kb
 *   GET  /                      -> demo page
 *   (the agent's chat endpoint is served by routeAgentRequest at /agents/*)
 */
/// <reference types="@cloudflare/workers-types" />
import { KuralleAgent } from '@kuralle-agents/cf-agent';
import type { HarnessConfig } from '@kuralle-agents/cf-agent';
import { defineAgent } from '@kuralle-agents/core';
import { sqlFileSystem, createFsTool } from '@kuralle-agents/fs';
import type { FileSystem } from '@kuralle-agents/core';
import { createOpenAI } from '@ai-sdk/openai';
import { routeAgentRequest } from 'agents';

interface Env {
  OPENAI_API_KEY: string;
  WorkspaceAgent: DurableObjectNamespace;
}

export class WorkspaceAgent extends KuralleAgent<Env> {
  /** Persistent workspace on THIS agent's DO SQLite. Lazy so `ctx` is ready. */
  private workspaceFs?: FileSystem;
  private fs(): FileSystem {
    return (this.workspaceFs ??= sqlFileSystem(this.ctx.storage.sql));
  }

  protected getAgents(): HarnessConfig['agents'] {
    const model = createOpenAI({ apiKey: this.env.OPENAI_API_KEY })('gpt-4o-mini');
    const fs = this.fs();
    return [
      defineAgent({
        id: 'workspace-agent',
        model,
        instructions:
          'You have a persistent workspace filesystem. Use the workspace tool to read and write ' +
          'files ({ op: "read" | "write" | "ls", path, content }). Anything you write persists.',
        workspace: { fs, readOnly: false },
        tools: { workspace: createFsTool({ fs, readOnly: false }) },
      }),
    ];
  }

  protected getDefaultAgentId(): string {
    return 'workspace-agent';
  }

  /** Simple HTTP fs routes (for verification), alongside the cf-agent chat endpoint. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const fs = this.fs();
    try {
      if (url.pathname === '/fs/write' && request.method === 'POST') {
        const { path, content } = (await request.json()) as { path?: string; content?: string };
        if (!path || content === undefined) return json({ error: 'path and content required' }, 400);
        const dir = path.replace(/\/[^/]*$/, '') || '/';
        if (dir !== '/') await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path, content);
        return json({ ok: true, wrote: path, bytes: content.length });
      }
      if (url.pathname === '/fs/read') {
        const path = url.searchParams.get('path');
        if (!path) return json({ error: 'path required' }, 400);
        return json({ path, content: await fs.readFile(path) });
      }
      if (url.pathname === '/fs/ls') {
        const path = url.searchParams.get('path') ?? '/';
        return json({ path, entries: await fs.readdir(path) });
      }
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    return super.fetch(request);
  }
}

const PAGE = `<!doctype html><meta charset=utf-8><title>kuralle-fs on Cloudflare (cf-agent)</title>
<style>body{font:15px/1.5 system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem}code,pre{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}pre{padding:1rem;overflow:auto}</style>
<h1>kuralle-fs — persistent workspace via cf-agent (KuralleAgent DO)</h1>
<p>A <code>KuralleAgent</code> Durable Object whose <code>workspace</code> is a <code>SqlFileSystem</code>
over its own <code>ctx.storage.sql</code>. Files written in one request are read back in another —
persistence through the cf-agent runtime on real Cloudflare infra.</p>
<pre>curl -X POST "$URL/fs/write" -H 'content-type: application/json' -d '{"path":"/kb/hours.md","content":"Open 9-5"}'
curl "$URL/fs/read?path=/kb/hours.md"
curl "$URL/fs/ls?path=/kb"</pre>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(PAGE.replaceAll('$URL', url.origin), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    // /fs/* -> the singleton workspace agent DO; everything else -> agent chat routing.
    if (url.pathname.startsWith('/fs/')) {
      const stub = env.WorkspaceAgent.get(env.WorkspaceAgent.idFromName('demo'));
      return stub.fetch(request);
    }
    return (
      (await routeAgentRequest(request, env)) ??
      new Response('not found', { status: 404 })
    );
  },
};
