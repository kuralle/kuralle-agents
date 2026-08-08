import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import { mcpTools } from '../src/index.js';
import { defaultEchoTool, startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext } from './helpers/tool-context.js';

describe('MCP round-trip', () => {
  it('connects, lists tools, calls echo, and returns the result', async () => {
    const stub = startStubMcpServer({ tools: [defaultEchoTool()] });

    try {
      const tools = await mcpTools([
        {
          name: 'stub',
          type: 'streamable-http',
          url: stub.url,
        },
      ]);

      expect(Object.keys(tools)).toEqual(['stub__echo']);

      const session = createMockSession();
      const ctx = minimalToolContext(session);
      const result = await tools['stub__echo']!.execute(
        { message: 'hello-mcp' },
        ctx,
      );

      expect(result).toBe('hello-mcp');
    } finally {
      stub.close();
    }
  });
});
