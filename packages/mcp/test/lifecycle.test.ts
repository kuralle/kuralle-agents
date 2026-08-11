import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import { z } from 'zod';
import { mcpTools } from '../src/index.js';
import { defaultEchoTool, startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext } from './helpers/tool-context.js';

const ctx = () => minimalToolContext(createMockSession());

/**
 * A tool that blocks until the test releases it. The release matters: a handler left
 * hanging when the stub server shuts down produces an unhandled rejection that lands on
 * whichever test happens to be running next.
 */
function hangingTool(hooks: { onStart: () => void; release: Promise<void> }) {
  return {
    name: 'hang',
    description: 'Blocks until the test releases it',
    inputSchema: z.object({}),
    handler: async () => {
      hooks.onStart();
      await hooks.release;
      return 'released';
    },
  };
}

describe('MCP connection lifecycle', () => {
  it('cancels the in-flight call when the turn aborts', async () => {
    // Without the signal reaching `tools/call`, the request stays outstanding and this
    // promise never settles — the turn's abort would reject our wrapper while the server
    // kept working. The test hangs rather than fails, which is the shape of the bug.
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseHang: () => void = () => {};
    const release = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });

    const stub = startStubMcpServer({
      tools: [hangingTool({ onStart: () => markStarted(), release })],
    });
    const { tools, close } = await mcpTools([
      { name: 'slow', type: 'streamable-http', url: stub.url },
    ]);

    try {
      const controller = new AbortController();
      const toolContext = { ...ctx(), abortSignal: controller.signal };

      const pending = tools['slow__hang']!.execute({}, toolContext);
      await started;
      controller.abort();

      await expect(pending).rejects.toThrow();
    } finally {
      releaseHang();
      await close();
      stub.close();
    }
  }, 5_000);

  it('close() ends the connection, so a later call cannot reach the server', async () => {
    const stub = startStubMcpServer({ tools: [defaultEchoTool()] });
    const { tools, close } = await mcpTools([
      { name: 'stub', type: 'streamable-http', url: stub.url },
    ]);

    try {
      expect(await tools['stub__echo']!.execute({ message: 'before' }, ctx())).toBe('before');

      await close();

      await expect(
        tools['stub__echo']!.execute({ message: 'after' }, ctx()),
      ).rejects.toThrow(/unavailable/i);
    } finally {
      stub.close();
    }
  });

  it('close() is idempotent, so a session teardown path can call it twice', async () => {
    const stub = startStubMcpServer({ tools: [defaultEchoTool()] });
    const { close } = await mcpTools([
      { name: 'stub', type: 'streamable-http', url: stub.url },
    ]);

    try {
      await close();
      await close();
    } finally {
      stub.close();
    }
  });

  it('closes every server in the toolset, not only the first', async () => {
    const one = startStubMcpServer({ tools: [defaultEchoTool()] });
    const two = startStubMcpServer({ tools: [defaultEchoTool()] });

    const { tools, close } = await mcpTools([
      { name: 'one', type: 'streamable-http', url: one.url },
      { name: 'two', type: 'streamable-http', url: two.url },
    ]);

    try {
      expect(Object.keys(tools).sort()).toEqual(['one__echo', 'two__echo']);
      await close();

      await expect(tools['one__echo']!.execute({ message: 'x' }, ctx())).rejects.toThrow();
      await expect(tools['two__echo']!.execute({ message: 'x' }, ctx())).rejects.toThrow();
    } finally {
      one.close();
      two.close();
    }
  });
});
