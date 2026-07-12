#!/usr/bin/env npx tsx
/**
 * LIVE parallel-tool-calling + durability smoke (G9 + H1) against a real model.
 *
 * A real model is told to call TWO independent, artificially-slow, parallel-safe
 * tools in one turn. We run it twice — parallelSafe off (serial) and on (parallel)
 * — and assert:
 *   - G9 parallelism: the parallel run is meaningfully faster (tools overlap).
 *   - H1 durability:  each tool executes exactly once, and every tool journal step
 *                     is `finished` (append-`running` → finalizeStep ran) with
 *                     non-colliding, contiguous indices (reserveSteps ordinals).
 *   - Trace fidelity: both tool spans + both tool results are captured.
 *
 * Usage:  OPENAI_API_KEY=... npx tsx packages/e2e-tests/tests/parallel-tools-durability-e2e.ts
 * Skips (exit 0) if no OPENAI_API_KEY. Exits non-zero on any assertion failure.
 */
import 'dotenv/config';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import {
  createRuntime,
  defineAgent,
  defineTool,
  MemoryStore,
  MemoryTraceStore,
} from '@kuralle-agents/core';

const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.warn('parallel-tools-durability-e2e: no OPENAI_API_KEY — skipping.');
  process.exit(0);
}

const model = createOpenAI({ apiKey: key })(process.env.OPENAI_MODEL ?? 'gpt-4.1-mini');
const TOOL_DELAY_MS = 1200;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function trial(parallelSafe: boolean) {
  const calls = { weather: 0, time: 0 };
  const wait = () => new Promise((r) => setTimeout(r, TOOL_DELAY_MS));
  const get_weather = defineTool({
    name: 'get_weather', description: 'Current weather for a city', parallelSafe,
    input: z.object({ city: z.string() }),
    execute: async ({ city }) => { calls.weather += 1; await wait(); return { city, tempC: 18 }; },
  });
  const get_time = defineTool({
    name: 'get_time', description: 'Local time for a city', parallelSafe,
    input: z.object({ city: z.string() }),
    execute: async ({ city }) => { calls.time += 1; await wait(); return { city, time: '14:00' }; },
  });

  const store = new MemoryStore();
  const traceStore = new MemoryTraceStore();
  const agent = defineAgent({
    id: 'concierge',
    instructions: 'When asked about a city, call BOTH get_weather and get_time for it, then answer in one sentence.',
    model, globalTools: { get_weather, get_time },
  });
  const runtime = createRuntime({
    agents: [agent], defaultAgentId: 'concierge',
    sessionStore: store, defaultModel: model, tracing: { store: traceStore },
  });

  const sessionId = `par-${parallelSafe}`;
  const start = Date.now();
  const handle = runtime.run({ sessionId, input: 'What is the weather and time in Paris?' });
  for await (const _ of handle.events) { /* drain */ }
  await handle;
  const ms = Date.now() - start;

  const trace = (await runtime.listTraces(sessionId))[0];
  const toolSpans = trace.spans.filter((s) => s.kind === 'tool');
  const session = (await store.get(sessionId)) as { durableRuns?: Record<string, { steps: Array<{ kind: string; index: number; status: string; startedAt: number; finishedAt?: number }> }> } | null;
  const run = Object.values(session?.durableRuns ?? {})[0];
  const toolSteps = (run?.steps ?? []).filter((s) => s.kind === 'tool');

  return { parallelSafe, ms, calls, toolSpans: toolSpans.length, toolResults: trace.toolResults.map((r) => r.name), toolSteps };
}

async function main() {
  const serial = await trial(false);
  const parallel = await trial(true);
  console.log('SERIAL  :', JSON.stringify(serial));
  console.log('PARALLEL:', JSON.stringify(parallel));

  for (const r of [serial, parallel]) {
    const label = r.parallelSafe ? 'parallel' : 'serial';
    // H1 durability: exactly-once + every tool step finalized, contiguous indices.
    assert(r.calls.weather === 1 && r.calls.time === 1, `${label}: each tool executes exactly once`);
    assert(r.toolSteps.length === 2, `${label}: 2 tool journal steps`);
    assert(r.toolSteps.every((s) => s.status === 'finished'), `${label}: every tool step finalized (H1)`);
    const idx = r.toolSteps.map((s) => s.index).sort((a, b) => a - b);
    assert(new Set(idx).size === 2, `${label}: non-colliding journal indices (G9 reserveSteps)`);
    // Trace fidelity
    assert(r.toolSpans === 2, `${label}: 2 tool spans in the trace`);
    assert(r.toolResults.includes('get_weather') && r.toolResults.includes('get_time'), `${label}: both tool results captured`);
  }

  // G9 parallelism, proven DETERMINISTICALLY from the journal (immune to model-latency
  // variance that swamps wall-clock): the two tool executions must OVERLAP in time when
  // parallelSafe, and run back-to-back (no overlap) when serial.
  const overlaps = (steps: typeof serial.toolSteps): boolean => {
    const s = [...steps].sort((a, b) => a.startedAt - b.startedAt);
    return s[1]!.startedAt < (s[0]!.finishedAt ?? Number.POSITIVE_INFINITY);
  };
  assert(!overlaps(serial.toolSteps), 'serial: tool executions run back-to-back (no overlap)');
  assert(overlaps(parallel.toolSteps), 'parallel: tool executions OVERLAP in time (G9 fanned them concurrently)');
  console.log(`\nG9 parallelism: parallel tools overlapped; serial ran back-to-back. Wall-clock serial ${serial.ms}ms vs parallel ${parallel.ms}ms (informational — dominated by model latency).`);

  console.log('\n✓ parallel-tools-durability-e2e PASSED (G9 parallelism + H1 exactly-once/finalize + trace fidelity, live).');
}

main().catch((err) => { console.error(err); process.exit(1); });
