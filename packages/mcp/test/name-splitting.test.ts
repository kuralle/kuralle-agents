import { describe, expect, it } from 'bun:test';
import { mcpTools } from '../src/index.js';
import { startStubMcpServer } from './helpers/stub-server.js';
import { z } from 'zod';

describe('MCP tool naming', () => {
  it('uses double underscore so my_server + do_it is unambiguous', async () => {
    const stub = startStubMcpServer({
      tools: [
        {
          name: 'do_it',
          description: 'Do it',
          inputSchema: z.object({}),
          handler: () => 'done',
        },
      ],
    });

    try {
      const tools = await mcpTools([
        {
          name: 'my_server',
          type: 'streamable-http',
          url: stub.url,
        },
      ]);

      expect(Object.keys(tools)).toEqual(['my_server__do_it']);
    } finally {
      stub.close();
    }
  });
});
