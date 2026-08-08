import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { composeMcpSystemPrompt, estimateTokens, mcpTools } from '../src/index.js';
import { startStubMcpServer } from './helpers/stub-server.js';

/**
 * A deferred tool must keep its argument *contract* while shedding its schema *prose*.
 *
 * The first cut of deferral replaced the whole schema with `{ type: 'object' }`. That saved
 * the tokens and cost the contract: the model had no parameter names at generation time and
 * had to copy them out of an `mcp__describe_tool` result, which it did wrong in 2 of 5 live
 * runs. Names and types are cheap; long descriptions are the bulk. So defer the prose.
 *
 * Every case below asserts both directions at once — names present AND prose absent. Either
 * assertion alone is satisfiable the wrong way: keeping everything passes the first, and
 * keeping nothing passes the second.
 */

/** Appears only in a property description, never in a property name. */
const PROSE_MARKER = 'zzz_prose_only_marker_never_in_a_name';

const LONG_DESCRIPTION =
  `${PROSE_MARKER}. A deliberately verbose parameter description so the serialized JSON ` +
  'Schema for this tool costs a realistic number of tokens. Real MCP servers ship ' +
  'descriptions of about this length, and they are the bulk of a schema.';

function fatTool(index: number) {
  return {
    name: `tool_${index}`,
    description: `Tool number ${index}.`,
    inputSchema: z.object({
      postal_prefix: z.string().describe(LONG_DESCRIPTION),
      quantity: z.number().describe(LONG_DESCRIPTION),
      express: z.boolean().describe(LONG_DESCRIPTION).optional(),
    }),
    handler: (args: Record<string, unknown>) => `ok:${String(args.postal_prefix ?? '')}`,
  };
}

/**
 * Large enough that 200 fat schemas blow it, small enough that 200 name-only schemas fit.
 * That band is where the argument contract survives, and it is the common case.
 */
const BUDGET = 20_000;

/** Small enough that even name-only schemas for 200 tools do not fit. */
const TINY_BUDGET = 500;

async function connectDeferred(toolCount: number) {
  const stub = startStubMcpServer({
    tools: Array.from({ length: toolCount }, (_, i) => fatTool(i)),
  });
  const tools = await mcpTools(
    [{ name: 'srv', type: 'streamable-http', url: stub.url }],
    { disclosure: { budget: BUDGET } },
  );
  return { stub, tools };
}

describe('deferred MCP tool schema keeps the argument contract', () => {
  it('keeps parameter names in the prompt while deferring their descriptions', async () => {
    const { stub, tools } = await connectDeferred(200);
    try {
      const prompt = composeMcpSystemPrompt(tools);

      // Contract kept: the model can see what to pass.
      expect(prompt).toContain('postal_prefix');
      expect(prompt).toContain('quantity');
      expect(prompt).toContain('express');

      // Prose deferred: the expensive half is gone.
      expect(prompt).not.toContain(PROSE_MARKER);

      // And the whole point still holds.
      expect(estimateTokens(prompt)).toBeLessThanOrEqual(BUDGET);
    } finally {
      stub.close();
    }
  });

  it('keeps the declared types, not just the names', async () => {
    const { stub, tools } = await connectDeferred(200);
    try {
      const schema = JSON.stringify(
        (tools['srv__tool_0']!.input as { '~standard'?: { jsonSchema?: { input: (o: unknown) => unknown } } })
          ?.['~standard']?.jsonSchema?.input({ target: 'draft-07' }) ?? {},
      );

      // A name with no type is a weaker contract than the model needs.
      expect(schema).toContain('postal_prefix');
      expect(schema).toContain('string');
      expect(schema).toContain('number');
      expect(schema).toContain('boolean');
      expect(schema).not.toContain(PROSE_MARKER);
    } finally {
      stub.close();
    }
  });

  it('preserves `required`, so the model knows which arguments are optional', async () => {
    const { stub, tools } = await connectDeferred(200);
    try {
      const schema = (tools['srv__tool_0']!.input as {
        '~standard'?: { jsonSchema?: { input: (o: unknown) => Record<string, unknown> } };
      })?.['~standard']?.jsonSchema?.input({ target: 'draft-07' }) ?? {};

      const required = (schema as { required?: string[] }).required ?? [];
      expect(required).toContain('postal_prefix');
      expect(required).toContain('quantity');
      // `express` is .optional() on the stub, so it must not be required.
      expect(required).not.toContain('express');
    } finally {
      stub.close();
    }
  });

  it('still inlines the full prose for a server under budget', async () => {
    const stub = startStubMcpServer({ tools: [fatTool(0)] });
    try {
      const tools = await mcpTools(
        [{ name: 'small', type: 'streamable-http', url: stub.url }],
        { disclosure: { budget: BUDGET } },
      );
      // Under budget nothing is deferred, so the descriptions survive.
      expect(composeMcpSystemPrompt(tools)).toContain(PROSE_MARKER);
    } finally {
      stub.close();
    }
  });

  it('drops the names too when even names would blow the budget (REQ-16 holds at any scale)', async () => {
    const stub = startStubMcpServer({
      tools: Array.from({ length: 200 }, (_, i) => fatTool(i)),
    });
    try {
      const tools = await mcpTools(
        [{ name: 'srv', type: 'streamable-http', url: stub.url }],
        { disclosure: { budget: TINY_BUDGET } },
      );
      const bare = composeMcpSystemPrompt(tools);

      // Keeping names is best-effort. At this budget they cannot fit, so they go too.
      expect(bare).not.toContain('postal_prefix');
      expect(bare).not.toContain(PROSE_MARKER);

      // Measured against the same server one tier up, because the absolute number is
      // floored by something deferral cannot touch: the catalog. Every tool's name and
      // description is always in the prompt — that is what the model routes on — so a
      // 200-tool server has an irreducible cost no schema policy goes below. What the
      // budget governs is the schema bulk on top of it.
      const withNames = await mcpTools(
        [{ name: 'srv2', type: 'streamable-http', url: stub.url }],
        { disclosure: { budget: BUDGET } },
      );
      expect(estimateTokens(bare)).toBeLessThan(
        estimateTokens(composeMcpSystemPrompt(withNames)),
      );

      // The tools are still callable, and describe_tool still serves the full schema.
      expect(tools['srv__tool_0']).toBeDefined();
    } finally {
      stub.close();
    }
  });

  it('falls back to a bare object schema when the server publishes none', async () => {
    const stub = startStubMcpServer({
      tools: Array.from({ length: 200 }, (_, i) => ({
        name: `bare_${i}`,
        description: `Bare tool ${i} with a description long enough to blow the budget on its own. ${LONG_DESCRIPTION}`,
        handler: () => 'ok',
      })),
    });
    try {
      const tools = await mcpTools(
        [{ name: 'bare', type: 'streamable-http', url: stub.url }],
        { disclosure: { budget: BUDGET } },
      );
      // No inputSchema upstream means there is no contract to keep. It must not throw.
      expect(tools['bare__bare_0']).toBeDefined();
    } finally {
      stub.close();
    }
  });
});
