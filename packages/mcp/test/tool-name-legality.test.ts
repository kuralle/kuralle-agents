import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import { z } from 'zod';
import { isProviderLegalToolName, mcpTools } from '../src/index.js';
import { startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext } from './helpers/tool-context.js';

const ctx = () => minimalToolContext(createMockSession());

/**
 * MCP places almost no constraint on a published tool name. Model providers place a hard
 * one: `^[a-zA-Z0-9_-]{1,64}$`, enforced by rejecting the whole request. A name arriving
 * over the wire is untrusted input for that constraint like any other, so a server that
 * publishes a dotted or very long name must not be able to break every turn.
 */
describe('projected MCP tool names are provider-legal', () => {
  it('rewrites a name the provider would reject, and keeps it callable', async () => {
    const dotted = 'search.docs';
    const long = `find_${'x'.repeat(90)}`;
    const unicode = 'busca_café';

    const stub = startStubMcpServer({
      tools: [dotted, long, unicode].map((name) => ({
        name,
        description: `Tool published as ${name}`,
        inputSchema: z.object({ q: z.string() }),
        handler: (args: Record<string, unknown>) => `${name}:${String(args.q ?? '')}`,
      })),
    });

    const { tools, close } = await mcpTools([
      { name: 'srv', type: 'streamable-http', url: stub.url },
    ]);

    try {
      const names = Object.keys(tools);
      expect(names).toHaveLength(3);
      for (const name of names) {
        expect(isProviderLegalToolName(name)).toBe(true);
      }
      // Distinct remote tools must stay distinct after rewriting.
      expect(new Set(names).size).toBe(3);

      // Rewriting is not renaming into uselessness: the tool still reaches the right
      // remote tool, so the projected name is an addressing detail, not a behaviour change.
      const dottedKey = names.find((n) => n.startsWith('srv__search_docs'))!;
      expect(await tools[dottedKey]!.execute({ q: 'kuralle' }, ctx())).toBe(
        'search.docs:kuralle',
      );
    } finally {
      await close();
      stub.close();
    }
  });

  it('leaves an already-legal name untouched, so Policy rules keep matching', async () => {
    const stub = startStubMcpServer({
      tools: [
        {
          name: 'list_transactions',
          description: 'List transactions',
          inputSchema: z.object({}),
          handler: () => 'ok',
        },
      ],
    });

    const { tools, close } = await mcpTools([
      { name: 'bank', type: 'streamable-http', url: stub.url },
    ]);

    try {
      expect(Object.keys(tools)).toEqual(['bank__list_transactions']);
    } finally {
      await close();
      stub.close();
    }
  });

  it('is deterministic, because Policy rules and journal entries are written against it', async () => {
    const start = async () => {
      const stub = startStubMcpServer({
        tools: [
          {
            name: 'a.b.c',
            description: 'Dotted',
            inputSchema: z.object({}),
            handler: () => 'ok',
          },
        ],
      });
      const toolset = await mcpTools([
        { name: 'srv', type: 'streamable-http', url: stub.url },
      ]);
      const names = Object.keys(toolset.tools);
      await toolset.close();
      stub.close();
      return names;
    };

    expect(await start()).toEqual(await start());
  });
});
