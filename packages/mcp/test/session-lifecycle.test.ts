import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import type { Diagnostic } from '@kuralle-agents/plugins';
import { z } from 'zod';
import { connectMcpServer } from '../src/connect.js';
import { createMemoryMcpConnectionStore, mcpTools, rebuildMcpToolsFromStorage } from '../src/index.js';
import { defaultEchoTool, startStubMcpServer } from './helpers/stub-server.js';
import { listRemoteTools, seedTrustedListing } from './helpers/drift-fixture.js';
import { minimalToolContext } from './helpers/tool-context.js';

const ctx = () => minimalToolContext(createMockSession());

async function connectStub(
  stubUrl: string,
  onDiagnostic?: (d: Diagnostic) => void,
) {
  const connected = await connectMcpServer(
    { name: 'stub', type: 'streamable-http', url: stubUrl },
    {
      timeoutMs: 5_000,
      allowedHosts: null,
      stdio: false,
      onDiagnostic,
    },
  );
  if ('diagnostic' in connected) {
    throw new Error(connected.diagnostic.message);
  }
  return connected.server;
}

describe('MCP session termination on close', () => {
  it('sends DELETE with MCP-Session-Id on a stateful stub', async () => {
    const stub = startStubMcpServer({
      session: { id: 'test-session' },
      tools: [defaultEchoTool()],
    });
    const server = await connectStub(stub.url);

    try {
      await server.listTools();
      await server.close();

      const deletes = stub.session!.requests.filter((r) => r.httpMethod === 'DELETE');
      expect(deletes).toHaveLength(1);
      expect(deletes[0]!.sessionId).toBe('test-session');
    } finally {
      stub.close();
    }
  });

  it('sends no DELETE on a stateless stub', async () => {
    const stub = startStubMcpServer({ tools: [defaultEchoTool()] });
    const server = await connectStub(stub.url);

    try {
      await server.close();
      expect(stub.session).toBeUndefined();
    } finally {
      stub.close();
    }
  });

  it('resolves close when DELETE is answered 405 with no diagnostic', async () => {
    const stub = startStubMcpServer({
      session: {},
      tools: [defaultEchoTool()],
    });
    stub.session!.setDeleteStatus(405);
    const diagnostics: Diagnostic[] = [];
    const server = await connectStub(stub.url, (d) => diagnostics.push(d));

    try {
      await server.listTools();
      await server.close();
      expect(diagnostics.filter((d) => d.rule === 'connection-failure')).toHaveLength(0);
    } finally {
      stub.close();
    }
  });

  it('still closes the client when DELETE fails with 500 and emits a diagnostic', async () => {
    const stub = startStubMcpServer({
      session: {},
      tools: [defaultEchoTool()],
    });
    stub.session!.setDeleteStatus(500);
    const diagnostics: Diagnostic[] = [];
    const server = await connectStub(stub.url, (d) => diagnostics.push(d));

    try {
      await server.listTools();
      await server.close();
      expect(diagnostics.some((d) => d.rule === 'connection-failure')).toBe(true);
      await expect(server.callTool('echo', { message: 'closed' })).rejects.toThrow();
    } finally {
      stub.close();
    }
  });
});

describe('MCP session expiry recovery', () => {
  it('recovers after expiry and re-initializes without a session id', async () => {
    const stub = startStubMcpServer({
      session: {},
      tools: [defaultEchoTool()],
    });
    const server = await connectStub(stub.url);

    try {
      expect(await server.callTool('echo', { message: 'before' })).toBe('before');
      stub.session!.expire();
      expect(await server.callTool('echo', { message: 'after' })).toBe('after');

      const initializePosts = stub.session!.requests.filter(
        (r) => r.httpMethod === 'POST' && r.jsonRpcMethod === 'initialize',
      );
      expect(initializePosts).toHaveLength(2);
      expect(initializePosts.every((r) => r.sessionId === null)).toBe(true);
    } finally {
      await server.close();
      stub.close();
    }
  });

  it('bounds attempts when the server 404s every session-authenticated POST', async () => {
    const stub = startStubMcpServer({
      session: {},
      tools: [defaultEchoTool()],
    });
    const server = await connectStub(stub.url);

    try {
      await server.listTools();
      stub.session!.rejectSessionToolPosts();
      const before = stub.session!.requests.length;

      await expect(server.callTool('echo', { message: 'x' })).rejects.toThrow();

      const toolCalls = stub.session!.requests
        .slice(before)
        .filter((r) => r.httpMethod === 'POST' && r.jsonRpcMethod === 'tools/call');
      expect(toolCalls).toHaveLength(2);
    } finally {
      await server.close();
      stub.close();
    }
  });

  it('does not recover on a stateless server', async () => {
    // A stateless server issues no session id, so a 404 from it is not an expired session and must
    // not provoke a reconnect.
    //
    // Counted inside `intercept`, not against `stub.requests`: the 404 is returned from the
    // intercept hook, which runs before the stub records anything, so a reconnect attempt never
    // reaches the request log. Asserting on the log therefore cannot see the very behaviour this
    // test exists to forbid.
    let pastConnect = false;
    let postsAfterConnect = 0;
    const stub = startStubMcpServer({
      tools: [defaultEchoTool()],
      intercept: (request) => {
        if (!pastConnect || request.method !== 'POST') {
          return undefined;
        }
        postsAfterConnect += 1;
        return new Response('Session not found', { status: 404 });
      },
    });
    const server = await connectStub(stub.url);
    pastConnect = true;

    try {
      await expect(server.callTool('echo', { message: 'x' })).rejects.toThrow();
      // Exactly the one tools/call POST. A reconnect would add an `initialize` POST here.
      expect(postsAfterConnect).toBe(1);
    } finally {
      await server.close();
      stub.close();
    }
  });

  it('does not recover from a non-session 404 at connect time', async () => {
    const stub = startStubMcpServer({
      tools: [defaultEchoTool()],
      intercept: (request) => {
        if (!request.url.endsWith('/mcp')) {
          return new Response('Not Found', { status: 404 });
        }
        return undefined;
      },
    });
    const connected = await connectMcpServer(
      { name: 'stub', type: 'streamable-http', url: `${stub.url}/wrong-path` },
      { timeoutMs: 5_000, allowedHosts: null, stdio: false },
    );
    expect('diagnostic' in connected).toBe(true);
    stub.close();
  });
});

describe('MCP session recovery and tool drift guard', () => {
  const orderIdSchema = z.object({ orderId: z.string() });

  it('withholds a drifted tool after session recovery re-lists the catalogue', async () => {
    const store = createMemoryMcpConnectionStore();
    const stub = startStubMcpServer({
      session: {},
      tools: [
        defaultEchoTool(),
        {
          name: 'refund',
          description: 'Changed after expiry',
          inputSchema: orderIdSchema,
          handler: () => 'ok',
        },
      ],
    });
    const config = { name: 'pay', type: 'streamable-http' as const, url: stub.url };
    const live = await listRemoteTools(config);
    await seedTrustedListing(store, config, live, [
      live.find((t) => t.name === 'echo')!,
      { ...live.find((t) => t.name === 'refund')!, description: 'Refund a payment' },
    ]);

    const diagnostics: Diagnostic[] = [];
    const { tools, reconciled, close } = await rebuildMcpToolsFromStorage(
      [config],
      {
        storage: store,
        onDiagnostic: (d) => diagnostics.push(d),
      },
      { stdio: false },
    );

    try {
      expect(tools['pay__echo']).toBeDefined();
      expect(tools['pay__refund']).toBeUndefined();

      stub.session!.expire();
      await reconciled;

      expect(tools['pay__refund']).toBeUndefined();
      expect(
        diagnostics.some((d) => d.rule === 'tool-drift' && d.message.includes('refund')),
      ).toBe(true);
    } finally {
      await close();
      stub.close();
    }
  });
});

describe('MCP session lifecycle via mcpTools', () => {
  it('recovers through projected tools after session expiry', async () => {
    const stub = startStubMcpServer({
      session: {},
      tools: [defaultEchoTool()],
    });
    const { tools, close } = await mcpTools([
      { name: 'stub', type: 'streamable-http', url: stub.url },
    ]);

    try {
      expect(await tools['stub__echo']!.execute({ message: 'before' }, ctx())).toBe('before');
      stub.session!.expire();
      expect(await tools['stub__echo']!.execute({ message: 'after' }, ctx())).toBe('after');
    } finally {
      await close();
      stub.close();
    }
  });
});
