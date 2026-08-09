import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import { mcpTools } from '../src/index.js';
import { defaultEchoTool, startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext } from './helpers/tool-context.js';

const TOKEN = 'initialize-scoped-bearer';

/**
 * A server that rejects every JSON-RPC POST without the bearer — including
 * `initialize` and `tools/list`. This is the ordinary shape of an OAuth-protected
 * MCP server, and it is the case a connect-time credential gap fails against.
 */
function startProtectedStub() {
  const unauthorizedPaths: string[] = [];
  const stub = startStubMcpServer({
    tools: [defaultEchoTool()],
    intercept: (request) => {
      if (request.method !== 'POST') {
        return undefined;
      }
      if (request.headers.get('Authorization') !== `Bearer ${TOKEN}`) {
        unauthorizedPaths.push(new URL(request.url).pathname);
        return new Response('Unauthorized', { status: 401 });
      }
      return undefined;
    },
  });
  return { ...stub, unauthorizedPaths };
}

describe('MCP auth reaches the handshake', () => {
  it('authenticates initialize and tools/list, not only the tool call', async () => {
    const stub = startProtectedStub();
    const session = createMockSession({ id: 'sess-connect' });
    const diagnostics: string[] = [];

    let toolset;
    try {
      toolset = await mcpTools(
        [{ name: 'stub', type: 'streamable-http', url: stub.url }],
        {
          allowedHosts: ['127.0.0.1'],
          session,
          auth: async () => ({ token: TOKEN }),
          onDiagnostic: (d) => diagnostics.push(d.message),
        },
      );

      // Without a connect-time credential the handshake 401s, the server is dropped
      // with a diagnostic, and no tool is ever projected.
      expect(diagnostics).toEqual([]);
      expect(Object.keys(toolset.tools)).toEqual(['stub__echo']);
      expect(stub.unauthorizedPaths).toEqual([]);

      const result = await toolset.tools['stub__echo']!.execute(
        { message: 'authenticated' },
        minimalToolContext(session),
      );
      expect(result).toBe('authenticated');
    } finally {
      await toolset?.close();
      stub.close();
    }
  });

  it('hands the auth resolver the caller session, not a fabricated one', async () => {
    const stub = startProtectedStub();
    const session = createMockSession({ id: 'sess-real' });
    const seenSessionIds: string[] = [];

    let toolset;
    try {
      toolset = await mcpTools(
        [{ name: 'stub', type: 'streamable-http', url: stub.url }],
        {
          allowedHosts: ['127.0.0.1'],
          session,
          auth: async (_server, ctx) => {
            seenSessionIds.push(ctx.session.id);
            return { token: TOKEN };
          },
        },
      );

      expect(seenSessionIds).toContain('sess-real');
      expect(seenSessionIds).not.toContain('mcp-connect');
    } finally {
      await toolset?.close();
      stub.close();
    }
  });

  it('refuses dynamic auth with no session to scope it to', async () => {
    await expect(
      mcpTools([{ name: 'stub', type: 'streamable-http', url: 'https://example.test/mcp' }], {
        auth: async () => ({ token: TOKEN }),
      }),
    ).rejects.toThrow(/session/i);
  });

  it('refuses a per-server allowedHosts resolver with no session to scope it to', async () => {
    await expect(
      mcpTools([{ name: 'stub', type: 'streamable-http', url: 'https://example.test/mcp' }], {
        allowedHosts: () => ['example.test'],
      }),
    ).rejects.toThrow(/session/i);
  });

  it('still connects a server that needs no dynamic credential without a session', async () => {
    const stub = startStubMcpServer({ tools: [defaultEchoTool()] });
    let toolset;
    try {
      toolset = await mcpTools([
        { name: 'open', type: 'streamable-http', url: stub.url },
      ]);
      expect(Object.keys(toolset.tools)).toEqual(['open__echo']);
    } finally {
      await toolset?.close();
      stub.close();
    }
  });
});
