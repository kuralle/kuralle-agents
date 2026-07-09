#!/usr/bin/env bun
/**
 * Streaming-by-default smoke — offline mock model, no API key.
 * Run: bun run packages/core/examples/streaming-smoke.ts
 * Assert: ... | grep -c '"type":"text-delta"'  # expect > 1
 */

import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { defineAgent } from '../src/authoring/defineAgent.js';
import { createRuntime } from '../src/runtime/Runtime.js';
import { MemoryStore } from '../src/session/stores/MemoryStore.js';
import { newSessionId } from '../src/runtime/openRun.js';
import type { HarnessStreamPart } from '../src/types/stream.js';

const CHUNKS = ['Hello', ' there.', ' How', ' can I help?'];
const STREAM_ID = 'mock-stream';

const DEFAULT_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function mockStreamChunks(deltas: string[]) {
  return [
    { type: 'stream-start' as const, warnings: [] as const },
    { type: 'text-start' as const, id: STREAM_ID },
    ...deltas.map((delta) => ({ type: 'text-delta' as const, id: STREAM_ID, delta })),
    { type: 'text-end' as const, id: STREAM_ID },
    {
      type: 'finish' as const,
      usage: DEFAULT_USAGE,
      finishReason: { unified: 'stop' as const, raw: undefined },
    },
  ];
}

const model = new MockLanguageModelV3({
  doStream: async () =>
    ({
      stream: simulateReadableStream({ chunks: mockStreamChunks(CHUNKS) }),
    }) as never,
});

const agent = defineAgent({
  id: 'streaming-smoke',
  name: 'Streaming Smoke',
  instructions: 'Reply briefly.',
  model,
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  sessionStore: new MemoryStore(),
  defaultModel: model,
});

const handle = runtime.run({ sessionId: newSessionId(), input: 'Hi' });

for await (const part of handle.events) {
  console.log(JSON.stringify(part satisfies HarnessStreamPart));
}

await handle;
