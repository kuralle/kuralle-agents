import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createMockSession } from '@kuralle-agents/core/testing';
import {
  composeMcpSystemPrompt,
  estimateTokens,
  mcpTools,
  DEFAULT_DISCLOSURE_BUDGET_TOKENS,
  MCP_DESCRIBE_TOOL,
} from '../src/index.js';
import { startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext } from './helpers/tool-context.js';

/**
 * REQ-16 — tool-definition size in the prompt stays under budget however many tools a
 * server publishes; a server under budget (or in `alwaysLoad`) is projected inline with
 * no extra round-trip.
 *
 * Every assertion here is written to be non-gameable in two directions at once: a token
 * measurement (which a coarse estimator could in principle be tuned against) is always
 * paired with a structural assertion on a marker string that only appears inside a full
 * input schema. Shrinking the estimate without actually withholding the schemas fails
 * the structural half; withholding the schemas without keeping the tools callable fails
 * the round-trip half.
 */

/** Appears only in a property description, never in a property name. */
const SCHEMA_MARKER = 'zzz_schema_only_marker_in_description';

function fatInputSchema(): z.ZodTypeAny {
  const longDescription =
    `${SCHEMA_MARKER}. A parameter whose description is deliberately verbose so that the serialized ` +
    'JSON Schema for this tool costs a realistic number of tokens rather than a ' +
    'toy number. Real MCP servers ship descriptions of about this length.';

  // Only the marker field is required, so the end-to-end case can call a deferred tool with
  // the single argument it retrieved. The optional siblings still carry their long
  // descriptions into the serialized JSON Schema, which is what makes the tool "fat".
  return z.object({
    marker_field: z.string().describe(longDescription),
    alpha: z.string().describe(longDescription).optional(),
    beta: z.string().describe(longDescription).optional(),
    gamma: z.string().describe(longDescription).optional(),
    delta: z.string().describe(longDescription).optional(),
    epsilon: z.string().describe(longDescription).optional(),
  });
}

function fatTools(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `tool_${index}`,
    description: `Tool number ${index}.`,
    inputSchema: fatInputSchema(),
    handler: (args: Record<string, unknown>) =>
      `called tool_${index} with ${String(args.marker_field ?? '')}`,
  }));
}

const BUDGET = 20_000;

describe('MCP tool disclosure budget (REQ-16)', () => {
  it('exposes a default budget of 10% of a 200k context window', () => {
    expect(DEFAULT_DISCLOSURE_BUDGET_TOKENS).toBe(20_000);
  });

  it('defers schemas for a 200-tool server, keeping the composed prompt under budget', async () => {
    const stub = startStubMcpServer({ tools: fatTools(200) });

    try {
      const tools = await mcpTools(
        [{ name: 'broad', type: 'streamable-http', url: stub.url }],
        { disclosure: { budget: BUDGET } },
      );

      const prompt = composeMcpSystemPrompt(tools);

      // The measurement the requirement is written in.
      expect(estimateTokens(prompt)).toBeLessThanOrEqual(BUDGET);

      // The structural half: no full schema reached the prompt.
      expect(prompt).not.toContain(SCHEMA_MARKER);

      // Every remote tool keeps its real qualified name, so Policy still discriminates
      // by tool name and transcripts still record what was actually called.
      expect(tools['broad__tool_0']).toBeDefined();
      expect(tools['broad__tool_199']).toBeDefined();

      // Deferral is visible as one retrieval tool, not as 200 missing tools.
      expect(tools[MCP_DESCRIBE_TOOL]).toBeDefined();
    } finally {
      stub.close();
    }
  });

  it('discriminates: the same 200 tools blow the budget when the server is exempted', async () => {
    const stub = startStubMcpServer({ tools: fatTools(200) });

    try {
      const tools = await mcpTools(
        [{ name: 'broad', type: 'streamable-http', url: stub.url }],
        { disclosure: { budget: BUDGET, alwaysLoad: ['broad'] } },
      );

      const prompt = composeMcpSystemPrompt(tools);

      // alwaysLoad means inline regardless of cost — this is what proves the deferral
      // assertion above is measuring deferral and not a weak estimator.
      expect(estimateTokens(prompt)).toBeGreaterThan(BUDGET);
      expect(prompt).toContain(SCHEMA_MARKER);
      expect(tools[MCP_DESCRIBE_TOOL]).toBeUndefined();
    } finally {
      stub.close();
    }
  });

  it('inlines a 3-tool server with zero retrieval calls', async () => {
    const stub = startStubMcpServer({ tools: fatTools(3) });

    try {
      const tools = await mcpTools(
        [{ name: 'small', type: 'streamable-http', url: stub.url }],
        { disclosure: { budget: BUDGET } },
      );

      const prompt = composeMcpSystemPrompt(tools);

      expect(estimateTokens(prompt)).toBeLessThanOrEqual(BUDGET);
      // Under budget the full schema is inline — the model needs no round-trip.
      expect(prompt).toContain(SCHEMA_MARKER);
      // Zero retrieval calls, guaranteed structurally: the tool does not exist.
      expect(tools[MCP_DESCRIBE_TOOL]).toBeUndefined();
      expect(Object.keys(tools).sort()).toEqual([
        'small__tool_0',
        'small__tool_1',
        'small__tool_2',
      ]);
    } finally {
      stub.close();
    }
  });

  it('lets the model retrieve a deferred schema and then call the tool end to end', async () => {
    const stub = startStubMcpServer({ tools: fatTools(200) });

    try {
      const tools = await mcpTools(
        [{ name: 'broad', type: 'streamable-http', url: stub.url }],
        { disclosure: { budget: BUDGET } },
      );

      const session = createMockSession();
      const ctx = minimalToolContext(session);

      const described = await tools[MCP_DESCRIBE_TOOL]!.execute(
        { tool: 'broad__tool_7' },
        ctx,
      );
      expect(JSON.stringify(described)).toContain(SCHEMA_MARKER);

      const result = await tools['broad__tool_7']!.execute(
        { marker_field: 'payload' },
        ctx,
      );
      expect(result).toBe('called tool_7 with payload');
    } finally {
      stub.close();
    }
  });

  it('applies the default budget when no disclosure option is supplied', async () => {
    const stub = startStubMcpServer({ tools: fatTools(200) });

    try {
      const tools = await mcpTools([
        { name: 'broad', type: 'streamable-http', url: stub.url },
      ]);

      const prompt = composeMcpSystemPrompt(tools);
      expect(estimateTokens(prompt)).toBeLessThanOrEqual(
        DEFAULT_DISCLOSURE_BUDGET_TOKENS,
      );
      expect(prompt).not.toContain(SCHEMA_MARKER);
    } finally {
      stub.close();
    }
  });

  it('decides per server, so a small server stays inline beside a deferred one', async () => {
    const broad = startStubMcpServer({ tools: fatTools(200) });
    const small = startStubMcpServer({
      tools: [
        {
          name: 'ping',
          description: 'Ping the service.',
          inputSchema: z.object({
            [`${SCHEMA_MARKER}_small`]: z.string().describe('small marker'),
          }),
          handler: () => 'pong',
        },
      ],
    });

    try {
      const tools = await mcpTools(
        [
          { name: 'broad', type: 'streamable-http', url: broad.url },
          { name: 'small', type: 'streamable-http', url: small.url },
        ],
        { disclosure: { budget: BUDGET } },
      );

      const prompt = composeMcpSystemPrompt(tools);

      expect(estimateTokens(prompt)).toBeLessThanOrEqual(BUDGET);
      // The small server's schema is inline; the broad server's is not.
      expect(prompt).toContain(`${SCHEMA_MARKER}_small`);
      expect(tools[MCP_DESCRIBE_TOOL]).toBeDefined();
      expect(tools['small__ping']).toBeDefined();
      expect(tools['broad__tool_0']).toBeDefined();
    } finally {
      broad.close();
      small.close();
    }
  });
});
