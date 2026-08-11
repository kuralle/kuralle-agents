import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import {
  createSqliteMcpConnectionStore,
  mcpTools,
  rebuildMcpToolsFromStorage,
} from '../src/index.js';
import type { AnyTool } from '@kuralle-agents/core';
import type { McpToolset } from '../src/index.js';

const SENTINEL_BEARER = 'SENTINEL_BEARER_MUST_NOT_PERSIST';
const SENTINEL_HEADER = 'SENTINEL_HEADER_MUST_NOT_PERSIST';

const SERVER_CONFIGS = [
  {
    name: 'stub',
    type: 'streamable-http' as const,
    url: 'https://stub.invalid/mcp',
    headers: {
      'X-Sentinel-Header': SENTINEL_HEADER,
    },
  },
];

/**
 * What the stub server publishes. Switched by `/catalog` so a test can persist one
 * catalogue, change the server underneath, and watch the woken tool map converge.
 */
let publishLegacyTool = true;

/**
 * Counts `tools/list` round trips. The whole point of the persisted listing is that a wake
 * makes none, and "the tools appeared" would pass with or without the cache — only the
 * request count tells the two apart.
 */
let listCalls = 0;

function inWorkerMcpFetch(): typeof fetch {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'workerd-stub', version: '1.0.0' });
    server.registerTool(
      'echo',
      {
        description: 'Echo the message field',
        inputSchema: z.object({ message: z.string() }),
      },
      async (args) => ({
        content: [{ type: 'text' as const, text: String(args.message ?? '') }],
      }),
    );
    if (publishLegacyTool) {
      server.registerTool(
        'legacy',
        {
          description: 'A tool the server later withdraws',
          inputSchema: z.object({}),
        },
        async () => ({ content: [{ type: 'text' as const, text: 'legacy' }] }),
      );
    }
    return server;
  });

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    // Read a clone: the original body still has to reach the handler intact.
    const body = await request.clone().text();
    if (body.includes('"method":"tools/list"')) {
      listCalls += 1;
    }
    return handler.fetch(request);
  }) as typeof fetch;
}

/**
 * A Durable Object *is* the session boundary, so the session-scoped toolset lands here
 * naturally: one DO, one session, one set of connections rebuilt on each wake.
 */
const DO_SESSION = { id: 's', conversationId: 'c' } as never;

function mcpOpts(storage: ReturnType<typeof createSqliteMcpConnectionStore>) {
  return {
    storage,
    fetch: inWorkerMcpFetch(),
    allowedHosts: ['stub.invalid'],
    session: DO_SESSION,
    auth: async () => ({ token: SENTINEL_BEARER }),
  };
}

function toolSessionContext() {
  return { session: DO_SESSION } as never;
}

export class McpHibernationDO extends DurableObject {
  private toolset: McpToolset | null = null;
  private readonly store: ReturnType<typeof createSqliteMcpConnectionStore>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = createSqliteMcpConnectionStore(this.ctx.storage.sql);
  }

  private async ensureTools(): Promise<Record<string, AnyTool>> {
    if (this.toolset) {
      return this.toolset.tools;
    }
    this.toolset = await rebuildMcpToolsFromStorage(SERVER_CONFIGS, mcpOpts(this.store), {
      stdio: false,
    });
    return this.toolset.tools;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      await this.toolset?.close();
      this.toolset = await mcpTools(SERVER_CONFIGS, mcpOpts(this.store));
      return Response.json({ tools: Object.keys(this.toolset.tools) });
    }

    if (url.pathname === '/call') {
      const tools = await this.ensureTools();
      const echo = tools['stub__echo'];
      if (!echo) {
        return new Response('stub__echo unavailable after wake', { status: 500 });
      }
      const result = await echo.execute({ message: 'hello-after-wake' }, toolSessionContext());
      return Response.json({ result });
    }

    if (url.pathname === '/catalog') {
      publishLegacyTool = url.searchParams.get('legacy') !== 'off';
      listCalls = 0;
      return Response.json({ publishLegacyTool });
    }

    if (url.pathname === '/wake') {
      // Counted the instant the map is ready, inside the same request. Reading a counter
      // afterwards would race the background reconciliation and prove nothing.
      listCalls = 0;
      this.toolset = await rebuildMcpToolsFromStorage(
        SERVER_CONFIGS,
        mcpOpts(this.store),
        { stdio: false },
      );
      const listCallsAtMapReady = listCalls;
      const toolsAtMapReady = Object.keys(this.toolset.tools).sort();

      await this.toolset.reconciled;

      return Response.json({
        listCallsAtMapReady,
        toolsAtMapReady,
        toolsAfterReconcile: Object.keys(this.toolset.tools).sort(),
        listCallsAfterReconcile: listCalls,
      });
    }

    if (url.pathname === '/call-withdrawn') {
      // Stands in for a turn that started before reconciliation: it captures the tool
      // handle from the cached map, and only then does the catalogue correct itself.
      listCalls = 0;
      this.toolset = await rebuildMcpToolsFromStorage(
        SERVER_CONFIGS,
        mcpOpts(this.store),
        { stdio: false },
      );
      const captured = this.toolset.tools['stub__legacy'];
      if (!captured) {
        return new Response('stub__legacy was not projected from the cache', {
          status: 500,
        });
      }

      await this.toolset.reconciled;

      try {
        await captured.execute({}, toolSessionContext());
        return Response.json({ error: null });
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (url.pathname === '/rows') {
      const rows = await this.store.list();
      return Response.json({ rows });
    }

    if (url.pathname === '/raw-storage-dump') {
      const dump = dumpRawSqlite(this.ctx.storage.sql);
      return Response.json({ dump });
    }

    return new Response('not found', { status: 404 });
  }
}

function dumpRawSqlite(sql: { exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> }): string {
  const parts: string[] = [];
  const tables = [...sql.exec("SELECT name FROM sqlite_master WHERE type='table'")];
  for (const table of tables) {
    const name = String(table.name);
    const rows = [...sql.exec(`SELECT * FROM "${name.replace(/"/g, '""')}"`)];
    parts.push(JSON.stringify({ table: name, rows }));
  }
  return parts.join('\n');
}

interface Env {
  MCP_DO: DurableObjectNamespace;
}

export default {
  fetch() {
    return new Response('ok');
  },
};
