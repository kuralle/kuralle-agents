import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import { mcpTools } from '../src/index.js';
import { defaultEchoTool, startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext, snapshotPersistedState } from './helpers/tool-context.js';

const SECRET = 'session-scoped-token-must-not-persist-7f3a';

describe('MCP credential persistence guard', () => {
  it('never writes auth tokens into persisted run state', async () => {
    const stub = startStubMcpServer({ tools: [defaultEchoTool()] });
    const session = createMockSession({ id: 'sess-a' });

    const { tools, close } = await mcpTools(
      [
        {
          name: 'stub',
          type: 'streamable-http',
          url: stub.url,
        },
      ],
      {
        allowedHosts: ['127.0.0.1'],
        session,
        auth: async (_server, ctx) => ({
          token: `${SECRET}:${ctx.session.id}`,
        }),
      },
    );

    try {
      const ctx = minimalToolContext(session);
      const before = snapshotPersistedState(session, ctx.runState);

      await tools['stub__echo']!.execute({ message: 'ok' }, ctx);

      const after = snapshotPersistedState(session, ctx.runState);
      expect(after.includes(SECRET)).toBe(false);
      expect(before).toBe(after);
    } finally {
      await close();
      stub.close();
    }
  });

  it('gives each session its own connection carrying only its own token', async () => {
    // `auth` is resolved before the MCP handshake, so the credential is fixed onto the
    // connection. That is what makes one toolset per session the unit of isolation: two
    // sessions cannot share a connection and swap bearers on it, and each handshake is
    // authenticated as the right principal.
    const seen: string[] = [];

    const stub = startStubMcpServer({ tools: [defaultEchoTool()] });

    const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth) {
        seen.push(auth);
      }
      return fetch(input as RequestInfo, init);
    }) as typeof fetch;

    const build = async (sessionId: string) => {
      const session = createMockSession({ id: sessionId });
      const toolset = await mcpTools(
        [{ name: 'stub', type: 'streamable-http', url: stub.url }],
        {
          allowedHosts: ['127.0.0.1'],
          session,
          fetch: recordingFetch,
          auth: async (_server, ctx) => ({ token: `token-for-${ctx.session.id}` }),
        },
      );
      return { toolset, session };
    };

    const a = await build('sess-a');
    const b = await build('sess-b');

    try {
      await a.toolset.tools['stub__echo']!.execute(
        { message: 'a' },
        minimalToolContext(a.session),
      );
      await b.toolset.tools['stub__echo']!.execute(
        { message: 'b' },
        minimalToolContext(b.session),
      );

      expect(seen.some((v) => v.includes('sess-a'))).toBe(true);
      expect(seen.some((v) => v.includes('sess-b'))).toBe(true);
      // No single request may carry both principals' tokens.
      expect(seen.some((v) => v.includes('sess-a') && v.includes('sess-b'))).toBe(false);
    } finally {
      await a.toolset.close();
      await b.toolset.close();
      stub.close();
    }
  });
});
