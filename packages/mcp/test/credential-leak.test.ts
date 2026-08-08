import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import { mcpTools } from '../src/index.js';
import { defaultEchoTool, startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext, snapshotPersistedState } from './helpers/tool-context.js';

const SECRET = 'session-scoped-token-must-not-persist-7f3a';

describe('MCP credential persistence guard', () => {
  it('never writes auth tokens into persisted run state', async () => {
    const stub = startStubMcpServer({ tools: [defaultEchoTool()] });

    try {
      const tools = await mcpTools(
        [
          {
            name: 'stub',
            type: 'streamable-http',
            url: stub.url,
          },
        ],
        {
          allowedHosts: ['127.0.0.1'],
          auth: async (_server, { session }) => ({
            token: `${SECRET}:${session.id}`,
          }),
        },
      );

      const session = createMockSession({ id: 'sess-a' });
      const ctx = minimalToolContext(session);
      const before = snapshotPersistedState(session, ctx.runState);

      await tools['stub__echo']!.execute({ message: 'ok' }, ctx);

      const after = snapshotPersistedState(session, ctx.runState);
      expect(after.includes(SECRET)).toBe(false);
      expect(before).toBe(after);
    } finally {
      stub.close();
    }
  });

  it('scopes auth tokens to the executing session', async () => {
    const seen: string[] = [];

    const stub = startStubMcpServer({ tools: [defaultEchoTool()] });

    try {
      const tools = await mcpTools(
        [
          {
            name: 'stub',
            type: 'streamable-http',
            url: stub.url,
          },
        ],
        {
          allowedHosts: ['127.0.0.1'],
          fetch: async (input, init) => {
            const headers = new Headers(init?.headers);
            const auth = headers.get('Authorization');
            if (auth) {
              seen.push(auth);
            }
            return fetch(input, init);
          },
          auth: async (_server, { session }) => ({
            token: `token-for-${session.id}`,
          }),
        },
      );

      const sessionA = createMockSession({ id: 'sess-a' });
      const sessionB = createMockSession({ id: 'sess-b' });

      await tools['stub__echo']!.execute(
        { message: 'a' },
        minimalToolContext(sessionA),
      );
      await tools['stub__echo']!.execute(
        { message: 'b' },
        minimalToolContext(sessionB),
      );

      expect(seen.some((v) => v.includes('sess-a'))).toBe(true);
      expect(seen.some((v) => v.includes('sess-b'))).toBe(true);
      expect(seen.some((v) => v.includes('sess-a') && v.includes('sess-b'))).toBe(false);
    } finally {
      stub.close();
    }
  });
});
