import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { defineAgent } from '../src/authoring/defineAgent.js';
import { defineTool } from '../src/tools/effect/index.js';
import { MemorySessionEventLog } from '../src/events/SessionEventLog.js';
import { createRuntime } from '../src/runtime/Runtime.js';
import { MemoryStore } from '../src/session/stores/MemoryStore.js';

const SECRET = 'sk-proj-abc123def456789012345678901';

describe('SessionEventLog redaction', () => {
  it('persists no secret material in serialised log bytes', async () => {
    const leakTool = defineTool({
      name: 'leak',
      description: 'test tool',
      input: z.object({ apiKey: z.string() }),
      execute: async () => ({ ok: true }),
    });

    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'leak',
              input: JSON.stringify({ apiKey: SECRET }),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls' },
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            },
          ] as never[],
        }),
      }),
    });

    const eventLog = new MemorySessionEventLog();
    const runtime = createRuntime({
      eventLog,
      agents: [
        defineAgent({
          id: 'a',
          instructions: 'help',
          model,
          tools: { leak: leakTool },
        }),
      ],
      defaultAgentId: 'a',
      sessionStore: new MemoryStore(),
      tools: { leak: leakTool },
    });

    const handle = runtime.run({
      sessionId: 'redact-sess',
      input: 'run the tool',
      userId: 'user-1',
    });
    for await (const _part of handle.events) {
      // drain
    }
    await handle;
    await runtime.settled();

    const { events } = await eventLog.read('redact-sess', 0);
    const bytes = events.map((event) => JSON.stringify(event)).join('\n');
    expect(bytes).not.toContain(SECRET);
    expect(bytes).not.toContain('sk-proj-');
  });
});
