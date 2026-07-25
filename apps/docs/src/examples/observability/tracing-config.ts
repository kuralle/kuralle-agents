import { openai } from '@ai-sdk/openai';
import { createRuntime, defineAgent, MemoryTraceStore } from '@kuralle-agents/core';

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini'),
});

// A native store you configure explicitly (here, for retention control) — the
// same MemoryTraceStore backs tracing by default even if `tracing` is omitted.
const traceStore = new MemoryTraceStore({ retentionMs: 24 * 60 * 60 * 1000 });

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  tracing: {
    store: traceStore, // canonical store — read back via getTrace/listTraces
    sampling: 0.25, // trace 1 in 4 runs; omit to trace every run
    redact: (span) => ({
      // strip tool payloads before they are persisted or exported
      ...span,
      attributes: { ...span.attributes, input: undefined, output: undefined },
    }),
  },
});

const handle = runtime.run({ input: 'Where is my order?', sessionId: 'session-42' });
for await (const part of handle.events) {
  if (part.type === 'text-delta') process.stdout.write(part.payload.delta);
}
await handle;

const traces = await runtime.listTraces('session-42');
const trace = traces[0] ? await runtime.getTrace(traces[0].traceId) : null;
console.log(trace?.spans.map((span) => span.name));
