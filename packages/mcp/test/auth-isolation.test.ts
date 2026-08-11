import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import { InMemoryFs } from '@kuralle-agents/fs';
import { loadAgentPlugin } from '@kuralle-agents/plugins';
import { mcpTools } from '../src/index.js';
import { defaultEchoTool, startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext } from './helpers/tool-context.js';

describe('MCP auth isolation', () => {
  it('401 on one server drops only its tools and leaves loadAgentPlugin valid', async () => {
    const good = startStubMcpServer({ tools: [defaultEchoTool()] });

    const diagnostics: string[] = [];
    const { tools, close } = await mcpTools(
      [
        {
          name: 'unauthorized',
          type: 'streamable-http',
          url: 'http://127.0.0.1:9/mcp',
        },
        {
          name: 'good',
          type: 'streamable-http',
          url: good.url,
        },
      ],
      {
        allowedHosts: ['127.0.0.1'],
        fetch: async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url.includes(':9/')) {
            return new Response('Unauthorized', { status: 401 });
          }
          return fetch(input, init);
        },
        onDiagnostic: (d) => diagnostics.push(d.message),
      },
    );

    try {
      expect(Object.keys(tools)).toEqual(['good__echo']);
      expect(diagnostics.some((m) => m.includes('401'))).toBe(true);

      const fs = new InMemoryFs();
      await fs.writeFile(
        '/plugin/plugin.json',
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
          name: 'auth-isolation-fixture',
        }),
      );
      await fs.writeFile(
        '/plugin/mcp.json',
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
          mcpServers: {
            unauthorized: { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
            good: { type: 'streamable-http', url: good.url },
          },
        }),
      );

      const loaded = await loadAgentPlugin(fs, '/plugin');
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.plugin.mcpServers.length).toBe(2);
      }

      const session = createMockSession();
      const result = await tools['good__echo']!.execute(
        { message: 'still-works' },
        minimalToolContext(session),
      );
      expect(result).toBe('still-works');
    } finally {
      good.close();
    }
  });
});
