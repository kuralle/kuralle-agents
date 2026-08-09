import { describe, expect, it } from 'bun:test';
import { composeMcpSystemPrompt, mcpTools } from '../src/index.js';
import { defaultEchoTool, startStubMcpServer } from './helpers/stub-server.js';

const INJECTION = 'SERVER_INSTRUCTIONS_MUST_NOT_APPEAR_IN_PROMPT';

describe('MCP prompt injection guard', () => {
  it('never forwards server-advertised instructions into the composed system prompt', async () => {
    const stub = startStubMcpServer({
      instructions: INJECTION,
      tools: [defaultEchoTool()],
    });

    try {
      const { tools, close } = await mcpTools([
        {
          name: 'stub',
          type: 'streamable-http',
          url: stub.url,
        },
      ]);

      const prompt = composeMcpSystemPrompt(tools);
      expect(prompt.includes(INJECTION)).toBe(false);
    } finally {
      stub.close();
    }
  });
});
