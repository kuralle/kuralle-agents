import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import { mcpTools } from '../src/index.js';
import {
  bankingTools,
  fashionTools,
  startExampleMcpServer,
} from '../examples/_server.js';
import { minimalToolContext } from './helpers/tool-context.js';

/**
 * The shared example MCP server. Five call sites depend on it — the Policy deny test,
 * the allowedHosts test, the disclosure-budget test, and both example plugins — so it
 * is worth pinning its contract here rather than letting each caller discover it.
 *
 * `port: 0` asks the OS for an ephemeral port; `handle.url` must reflect the real one,
 * otherwise parallel test files collide on a fixed port and fail intermittently.
 */

function ctx() {
  return minimalToolContext(createMockSession());
}

async function connect(url: string, name = 'example') {
  return mcpTools([{ name, type: 'streamable-http', url }], {
    allowedHosts: ['127.0.0.1', 'localhost'],
  });
}

describe('example MCP server', () => {
  it('serves the banking catalogue over Streamable HTTP on loopback', async () => {
    const server = await startExampleMcpServer({ port: 0, tools: bankingTools() });
    try {
      // Spec §7.2.1 permits plain HTTP only for loopback — the example plugins'
      // mcp.json stays conformant with no certificate because of this.
      expect(server.url).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/mcp$/);

      const tools = await connect(server.url, 'bank');
      const names = Object.keys(tools).sort();

      for (const expected of [
        'bank__get_balance',
        'bank__list_transactions',
        'bank__find_payee',
        'bank__transfer_funds',
        'bank__cancel_transfer',
      ]) {
        expect(names).toContain(expected);
      }
    } finally {
      await server.close();
    }
  });

  it('records exactly the calls it received, and nothing it did not', async () => {
    const server = await startExampleMcpServer({
      port: 0,
      tools: bankingTools(),
      record: true,
    });
    try {
      const tools = await connect(server.url, 'bank');
      expect(server.calls()).toHaveLength(0);

      await tools['bank__get_balance']!.execute({ account: 'chk-001' }, ctx());

      const calls = server.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.tool).toBe('get_balance');

      // The negative half is the whole point of `record`: a test that denies a call
      // must be able to prove it never reached the network, not merely that it threw.
      expect(calls.some((c) => c.tool === 'transfer_funds')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('fails only the named tools under failOn, leaving siblings answering', async () => {
    const server = await startExampleMcpServer({
      port: 0,
      tools: bankingTools(),
      failOn: ['transfer_funds'],
    });
    try {
      const tools = await connect(server.url, 'bank');

      await expect(
        tools['bank__transfer_funds']!.execute(
          { from: 'chk-001', to: 'payee-1', amount: 10 },
          ctx(),
        ),
      ).rejects.toThrow();

      // Per-server failure isolation is only meaningful if the siblings still work.
      const balance = await tools['bank__get_balance']!.execute(
        { account: 'chk-001' },
        ctx(),
      );
      expect(balance).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('pads to toolCount so the disclosure-budget case has 200 tools to defer', async () => {
    const server = await startExampleMcpServer({
      port: 0,
      tools: bankingTools(),
      toolCount: 200,
    });
    try {
      const tools = await connect(server.url, 'big');
      expect(Object.keys(tools).filter((n) => n.startsWith('big__'))).toHaveLength(200);
    } finally {
      await server.close();
    }
  });

  it('offers a fashion catalogue wide enough for deferral to be visible', async () => {
    const server = await startExampleMcpServer({ port: 0, tools: fashionTools() });
    try {
      const tools = await connect(server.url, 'shop');
      // The card asks for ~18; assert the property that matters (a wide surface)
      // rather than an exact count that would break on a sensible edit.
      expect(Object.keys(tools).length).toBeGreaterThanOrEqual(15);
    } finally {
      await server.close();
    }
  });

  it('closes cleanly so no test leaks a port', async () => {
    const server = await startExampleMcpServer({ port: 0, tools: bankingTools() });
    const url = server.url;
    await server.close();

    // After close the port must be genuinely released — a handle that resolves but
    // leaves the listener up is how a suite accumulates sockets until CI dies.
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
  });

  it('uses invented brand names only', async () => {
    const server = await startExampleMcpServer({ port: 0, tools: bankingTools() });
    try {
      const tools = await connect(server.url, 'bank');
      const text = JSON.stringify(
        Object.values(tools).map((t) => t.description),
      ).toLowerCase();
      // An example must not imitate a real institution. Spot-check the obvious ones.
      for (const real of ['hsbc', 'barclays', 'chase', 'monzo', 'revolut', 'zara', 'h&m']) {
        expect(text).not.toContain(real);
      }
    } finally {
      await server.close();
    }
  });
});
