import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createMockSession } from '@kuralle-agents/core/testing';
import { mcpTools } from '../src/index.js';
import { startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext } from './helpers/tool-context.js';

/**
 * Two places the client did not follow the MCP specification.
 *
 * Both were found by reading the spec against the implementation, and both fail silently,
 * which is why neither showed up in any existing test.
 */

function ctx() {
  return minimalToolContext(createMockSession());
}

/**
 * Rewrites `tools/list` responses so the server appears to paginate: the first page carries
 * `pageSize` tools and a `nextCursor`, and the cursored request carries the rest.
 *
 * The transport speaks SSE (`event: message\ndata: {json}`), so the rewrite parses that
 * envelope rather than plain JSON.
 */
function paginatingFetch(pageSize: number, cursorSeen: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestBody = typeof init?.body === 'string' ? init.body : '';
    const response = await fetch(input as RequestInfo, init);

    if (!requestBody.includes('"tools/list"')) {
      return response;
    }

    const cursor = /"cursor"\s*:\s*"([^"]+)"/.exec(requestBody)?.[1];
    if (cursor) {
      cursorSeen.push(cursor);
    }

    const raw = await response.text();
    const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) {
      return new Response(raw, { status: response.status, headers: response.headers });
    }

    const payload = JSON.parse(dataLine.slice('data: '.length)) as {
      result?: { tools?: unknown[]; nextCursor?: string };
    };
    const all = payload.result?.tools ?? [];

    if (!cursor) {
      payload.result = { tools: all.slice(0, pageSize), nextCursor: 'page-2' };
    } else {
      payload.result = { tools: all.slice(pageSize) };
    }

    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof fetch;
}

describe('MCP client protocol conformance', () => {
  it('follows nextCursor until the tool list is exhausted', async () => {
    const stub = startStubMcpServer({
      tools: Array.from({ length: 5 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool ${i}`,
        inputSchema: z.object({}),
        handler: () => `ok-${i}`,
      })),
    });
    const cursorSeen: string[] = [];

    try {
      const tools = await mcpTools(
        [{ name: 'srv', type: 'streamable-http', url: stub.url }],
        { fetch: paginatingFetch(2, cursorSeen) },
      );

      // Without cursor following, only the first page arrives and the rest vanish with no
      // error at all — the exact failure the disclosure budget would then mis-measure.
      expect(Object.keys(tools).sort()).toEqual([
        'srv__tool_0',
        'srv__tool_1',
        'srv__tool_2',
        'srv__tool_3',
        'srv__tool_4',
      ]);

      // And it must actually be pagination, not a lucky single page.
      expect(cursorSeen).toEqual(['page-2']);
    } finally {
      stub.close();
    }
  });

  it('surfaces a tool execution error instead of returning it as a successful result', async () => {
    const message = 'Invalid departure date: must be in the future.';
    const stub = startStubMcpServer({
      tools: [
        {
          name: 'book',
          description: 'Book a flight',
          inputSchema: z.object({ date: z.string() }),
          // The SDK marks a thrown handler as isError with the text in `content`.
          handler: () => {
            throw new Error(message);
          },
        },
      ],
    });

    try {
      const tools = await mcpTools([
        { name: 'travel', type: 'streamable-http', url: stub.url },
      ]);

      // Spec: a result with `isError: true` is a tool execution error. Returning its text
      // as a normal value tells the model the call succeeded, and records a success in the
      // durable journal. It must reject, and it must carry the server's message so the
      // model can self-correct rather than retry the same call.
      await expect(
        tools['travel__book']!.execute({ date: '1999-01-01' }, ctx()),
      ).rejects.toThrow(/must be in the future/);
    } finally {
      stub.close();
    }
  });

  it('rejects structuredContent that violates the tool\'s declared outputSchema', async () => {
    // The spec says clients SHOULD validate structured results against `outputSchema`.
    // We do not implement that ourselves — @modelcontextprotocol/client does it before a
    // result reaches us. This test exists because we depend on behaviour we do not own:
    // if the SDK ever drops it, an unvalidated payload reaches the agent silently.
    //
    // The rewrite below is what makes the test meaningful. An SDK-based server validates
    // its own outgoing structuredContent, so a violating payload cannot be produced
    // through the normal path — and a server that self-validates is exactly the case the
    // client-side check is NOT for. Injecting the violation on the wire simulates the
    // non-SDK, buggy or hostile server the spec is actually worried about.
    const stub = startStubMcpServer({
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          inputSchema: z.object({ city: z.string() }),
          outputSchema: z.object({ temperature: z.number(), conditions: z.string() }),
          handler: () => ({ temperature: 22, conditions: 'clear' }),
        },
      ],
    });

    const rogueFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const response = await fetch(input as RequestInfo, init);
      if (!body.includes('"tools/call"')) return response;

      const raw = await response.text();
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!line) return new Response(raw, { status: response.status, headers: response.headers });

      const payload = JSON.parse(line.slice('data: '.length)) as {
        result: { structuredContent?: unknown; content?: unknown };
      };
      // temperature must be a number; send a string, and drop `conditions` entirely.
      payload.result.structuredContent = { temperature: 'hot' };
      payload.result.content = [{ type: 'text', text: '{"temperature":"hot"}' }];
      return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        status: response.status,
        headers: response.headers,
      });
    }) as typeof fetch;

    try {
      const tools = await mcpTools(
        [{ name: 'w', type: 'streamable-http', url: stub.url }],
        { fetch: rogueFetch },
      );

      await expect(
        tools['w__get_weather']!.execute({ city: 'Oslo' }, ctx()),
      ).rejects.toThrow(/output schema/i);
    } finally {
      stub.close();
    }
  });

  it('still returns a normal result unchanged', async () => {
    const stub = startStubMcpServer({
      tools: [
        {
          name: 'echo',
          description: 'Echo',
          inputSchema: z.object({ message: z.string() }),
          handler: (args) => String(args.message ?? ''),
        },
      ],
    });
    try {
      const tools = await mcpTools([
        { name: 'srv', type: 'streamable-http', url: stub.url },
      ]);
      expect(await tools['srv__echo']!.execute({ message: 'fine' }, ctx())).toBe('fine');
    } finally {
      stub.close();
    }
  });
});
