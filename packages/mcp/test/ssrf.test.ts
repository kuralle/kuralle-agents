import { describe, expect, it } from 'bun:test';
import { mcpTools } from '../src/index.js';

describe('MCP SSRF guard', () => {
  it('blocks disallowed hosts without making outbound fetch calls', async () => {
    let fetchCalls = 0;
    const recordingFetch: typeof fetch = async (input, init) => {
      fetchCalls += 1;
      return fetch(input, init);
    };

    const diagnostics: string[] = [];
    const tools = await mcpTools(
      [
        {
          name: 'evil',
          type: 'streamable-http',
          url: 'http://evil.example.com/mcp',
        },
      ],
      {
        allowedHosts: ['127.0.0.1'],
        fetch: recordingFetch,
        onDiagnostic: (d) => diagnostics.push(d.message),
      },
    );

    expect(fetchCalls).toBe(0);
    expect(Object.keys(tools)).toEqual([]);
    expect(diagnostics.some((m) => m.includes('allowedHosts'))).toBe(true);
  });
});
