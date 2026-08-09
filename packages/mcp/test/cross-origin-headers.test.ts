import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import { mcpTools } from '../src/index.js';
import { defaultEchoTool, startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext } from './helpers/tool-context.js';

const ctx = () => minimalToolContext(createMockSession());
const TENANT_HEADER = 'X-Tenant';
const TENANT_VALUE = 'acme-private';
const BEARER = 'bearer-must-not-cross-origins';

/**
 * Agent Plugins §7.2.1: "A client MUST NOT forward configured headers to a different
 * origin through a redirect or legacy SSE endpoint event without explicit user
 * authorization."
 *
 * Measured before writing the guard: the platform follows a redirect *inside* one `fetch`
 * call, so a wrapper never sees the hop; and while it does strip `Authorization` across
 * origins, it carries a configured header like `X-Tenant` straight through. That is why
 * the client follows redirects manually rather than trusting the platform.
 */

interface Received {
  authorization: string | null;
  tenant: string | null;
}

/** A bare HTTP origin that records what it was sent and answers 200. */
function startRecordingOrigin() {
  const received: Received[] = [];
  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      received.push({
        authorization: request.headers.get('authorization'),
        tenant: request.headers.get(TENANT_HEADER.toLowerCase()),
      });
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  return {
    received,
    origin: `http://127.0.0.1:${listener.port}`,
    close: () => listener.stop(true),
  };
}

describe('cross-origin header forwarding (§7.2.1)', () => {
  it('withholds configured headers and the bearer on a cross-origin redirect', async () => {
    const attacker = startRecordingOrigin();
    const diagnostics: string[] = [];

    // The configured origin 307s every request to the attacker's origin.
    const redirector = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { location: `${attacker.origin}/mcp` },
        }),
    });

    const session = createMockSession({ id: 'sess-x' });
    let toolset;
    try {
      toolset = await mcpTools(
        [
          {
            name: 'redirecting',
            type: 'streamable-http',
            url: `http://127.0.0.1:${redirector.port}/mcp`,
            headers: { [TENANT_HEADER]: TENANT_VALUE },
          },
        ],
        {
          allowedHosts: ['127.0.0.1'],
          session,
          auth: async () => ({ token: BEARER }),
          onDiagnostic: (d) => diagnostics.push(d.rule),
        },
      );

      // The attacker origin must have been reached (proving the redirect was followed)
      // but must not have received either credential.
      expect(attacker.received.length).toBeGreaterThan(0);
      for (const hop of attacker.received) {
        expect(hop.tenant).toBeNull();
        expect(hop.authorization).toBeNull();
      }
      expect(diagnostics).toContain('cross-origin-headers-withheld');
    } finally {
      await toolset?.close();
      redirector.stop(true);
      attacker.close();
    }
  }, 20_000);

  it('still sends configured headers on a same-origin redirect', async () => {
    // Discriminates the test above: the guard must key on origin, not simply block every
    // redirect. Without this, "withhold everything always" would pass.
    const seen: Received[] = [];
    let port = 0;

    const listener = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/mcp') {
          return new Response(null, {
            status: 307,
            headers: { location: `http://127.0.0.1:${port}/relocated` },
          });
        }
        seen.push({
          authorization: request.headers.get('authorization'),
          tenant: request.headers.get(TENANT_HEADER.toLowerCase()),
        });
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      },
    });
    port = listener.port;

    const session = createMockSession({ id: 'sess-same' });
    let toolset;
    try {
      toolset = await mcpTools(
        [
          {
            name: 'same',
            type: 'streamable-http',
            url: `http://127.0.0.1:${port}/mcp`,
            headers: { [TENANT_HEADER]: TENANT_VALUE },
          },
        ],
        {
          allowedHosts: ['127.0.0.1'],
          session,
          auth: async () => ({ token: BEARER }),
        },
      );

      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]!.tenant).toBe(TENANT_VALUE);
      expect(seen[0]!.authorization).toBe(`Bearer ${BEARER}`);
    } finally {
      await toolset?.close();
      listener.stop(true);
    }
  }, 20_000);

  it('keeps a same-origin server working end to end', async () => {
    const stub = startStubMcpServer({ tools: [defaultEchoTool()] });
    const session = createMockSession({ id: 'sess-plain' });
    let toolset;
    try {
      toolset = await mcpTools(
        [{ name: 'stub', type: 'streamable-http', url: stub.url }],
        { allowedHosts: ['127.0.0.1'], session },
      );
      expect(
        await toolset.tools['stub__echo']!.execute({ message: 'intact' }, ctx()),
      ).toBe('intact');
    } finally {
      await toolset?.close();
      stub.close();
    }
  });
});

describe('cross-origin via the legacy SSE endpoint event (§7.2.1)', () => {
  it('refuses a cross-origin endpoint event, and the named origin receives nothing', async () => {
    // The sharpest case in the rule: on legacy HTTP+SSE the POST endpoint is supplied by
    // the *server*, so a compromised server can name an origin it controls.
    //
    // Measured: our own origin guard never runs here, because `SSEClientTransport` rejects
    // the endpoint first — "Endpoint origin does not match connection origin". This test
    // therefore pins behaviour we depend on but do not own, exactly like the outputSchema
    // guard in protocol-conformance.test.ts. If the SDK ever drops that check, our guard is
    // the backstop, and this test is what tells us the front stop went away.
    const attacker = startRecordingOrigin();
    const diagnostics: string[] = [];

    const sse = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/sse') {
          return new Response(`event: endpoint\ndata: ${attacker.origin}/messages\n\n`, {
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const session = createMockSession({ id: 'sess-sse' });
    let toolset;
    try {
      toolset = await mcpTools(
        [
          {
            name: 'legacy',
            type: 'sse',
            url: `http://127.0.0.1:${sse.port}/sse`,
            headers: { [TENANT_HEADER]: TENANT_VALUE },
          },
        ],
        {
          allowedHosts: ['127.0.0.1'],
          session,
          auth: async () => ({ token: BEARER }),
          onDiagnostic: (d) => diagnostics.push(d.message),
        },
      );

      // Positively assert the case was exercised and blocked, rather than looping over an
      // empty array and calling that a pass.
      expect(attacker.received).toHaveLength(0);
      expect(Object.keys(toolset.tools)).toEqual([]);
      expect(diagnostics.join(' ')).toMatch(/endpoint origin does not match/i);
    } finally {
      await toolset?.close();
      sse.stop(true);
      attacker.close();
    }
  }, 20_000);
});
