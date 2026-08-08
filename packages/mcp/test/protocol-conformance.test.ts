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
