import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
// Imports through the PACKAGE ROOT source entry (not deep module paths), which is the
// path a Worker consumer actually writes. Proves the root export is reachable and
// functional inside workerd, not merely that its own module file parses.
import { mcpTools } from '../src/index.js';
import type { Diagnostic } from '../src/types.js';

/**
 * REQ-13 — the same agent code connects on Node, Bun and workerd, and a `stdio` config
 * on workerd fails with a named, actionable error rather than a module-resolution crash.
 *
 * The server here runs *inside workerd* as a fetch handler wired through `opts.fetch`,
 * so the real Streamable HTTP framing is exercised by the real transport code on the
 * real runtime. workerd cannot open a listening socket, so a loopback port is not
 * available to us; routing the handler in as `fetch` is the strongest round-trip this
 * runtime admits, and it is a genuine protocol round-trip rather than a mock.
 */

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
    return server;
  });

  return ((input: RequestInfo | URL, init?: RequestInit) =>
    handler.fetch(new Request(input as RequestInfo, init))) as typeof fetch;
}

describe('MCP runtime matrix on workerd (REQ-13)', () => {
  it('connects a streamable-http server and round-trips a tool call inside workerd', async () => {
    const tools = await mcpTools(
      [{ name: 'stub', type: 'streamable-http', url: 'https://stub.invalid/mcp' }],
      {
        fetch: inWorkerMcpFetch(),
        allowedHosts: ['stub.invalid'],
      },
    );

    expect(Object.keys(tools)).toContain('stub__echo');

    const result = await tools['stub__echo']!.execute(
      { message: 'hello-workerd' },
      // The runtime supplies a full ToolContext; the projection only reads `session`.
      { session: { id: 's', conversationId: 'c' } } as never,
    );

    expect(result).toBe('hello-workerd');
  });

  it('rejects a stdio config on workerd with an error naming the transport AND the runtime', async () => {
    const diagnostics: Diagnostic[] = [];

    const tools = await mcpTools(
      [{ name: 'local', type: 'stdio', command: 'some-server' }],
      { onDiagnostic: (d) => diagnostics.push(d) },
    );

    // Per-server failure isolation: no crash, no tools, exactly one diagnostic.
    expect(Object.keys(tools)).toEqual([]);
    expect(diagnostics).toHaveLength(1);

    const [diagnostic] = diagnostics;
    expect(diagnostic!.rule).toBe('unsupported-transport');
    expect(diagnostic!.origin).toBe('local');

    const message = diagnostic!.message;

    // Names the transport.
    expect(message).toContain('stdio');
    // Names the runtime — the part that turns "it failed" into "it cannot work here".
    // A message that omits this reads as a missing install rather than a platform limit.
    expect(message).toMatch(/workers|workerd|cloudflare/i);
    // Names the remediation.
    expect(message).toContain('@kuralle-agents/mcp/node');
  });

  it('does not reach a stdio subprocess module from the root export', async () => {
    // If the root export ever pulled `@modelcontextprotocol/client/stdio` (and therefore
    // `cross-spawn`), stdio would silently *work* here and the guard above would be
    // testing nothing. Asserting the negative keeps that guard honest.
    const diagnostics: Diagnostic[] = [];
    await mcpTools([{ name: 'local', type: 'stdio', command: 'some-server' }], {
      onDiagnostic: (d) => diagnostics.push(d),
    });
    expect(diagnostics[0]!.rule).toBe('unsupported-transport');
  });
});
