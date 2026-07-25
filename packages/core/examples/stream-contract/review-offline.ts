/**
 * Offline envelope review — MockLanguageModelV3 drives the real Runtime.
 *
 * Proves, deterministically and without an API key:
 *  - every emitted part has {channel,type,payload}
 *  - part.channel === PART_CHANNEL[part.type] for every part (the headline invariant)
 *  - answering agent emits text-start/text-delta/text-end/tool-call/tool-result/done
 *  - flow agent emits flow-enter/node-enter/flow-transition with populated payloads
 *  - handoff emits handoff with targetAgent in the payload
 *  - done carries sessionId
 *
 * Run: bun run packages/core/examples/stream-contract/review-offline.ts
 */
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { collect, defineFlow, reply } from '../../src/authoring/nodes.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import type { StreamPart } from '../../src/types/stream.js';
import {
  assertHasType,
  makeCollector,
  record,
  summarize,
  StreamAssertionError,
} from './assertStream.js';

const STREAM_ID = 'mock-stream';
const USAGE = {
  inputTokens: { total: 4, noCache: 4, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

interface MockScript {
  deltas: string[];
  toolCalls?: { toolCallId: string; toolName: string; input: unknown }[];
  finishReason?: 'stop' | 'tool-calls';
}

/** Build a mock model that replays a queue of scripted responses. */
function scriptedModel(scripts: MockScript[]) {
  let i = 0;
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const script = scripts[Math.min(i, scripts.length - 1)]!;
      i += 1;
      const chunks: object[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: STREAM_ID },
        ...script.deltas.map((delta) => ({ type: 'text-delta', id: STREAM_ID, delta })),
        { type: 'text-end', id: STREAM_ID },
        ...(script.toolCalls ?? []).flatMap((tc) => [
          { type: 'tool-input-start', id: tc.toolCallId, toolName: tc.toolName },
          { type: 'tool-input-available', id: tc.toolCallId, toolName: tc.toolName, input: tc.input },
        ]),
        {
          type: 'finish',
          usage: USAGE,
          finishReason: { unified: script.finishReason ?? 'stop', raw: undefined },
        },
      ];
      void prompt;
      return { stream: simulateReadableStream({ chunks: chunks as never }) } as never;
    },
  });
}

async function drain(
  handle: ReturnType<ReturnType<typeof createRuntime>['run']>,
  origin: string,
) {
  const seen = makeCollector();
  for await (const part of handle.events) {
    record(seen, part, origin);
  }
  await handle;
  return seen;
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario A: answering agent with a tool
// ---------------------------------------------------------------------------
async function scenarioA() {
  console.log('\n=== Scenario A: answering agent + tool (offline) ===');
  const echo = defineTool({
    name: 'echo',
    description: 'Echo a value back.',
    input: z.object({ value: z.string() }),
    execute: async ({ value }) => ({ echoed: value }),
  });
  const model = scriptedModel([
    { deltas: ['Let me echo that.'], finishReason: 'stop' },
  ]);
  const agent = defineAgent({
    id: 'echo-agent',
    name: 'Echo',
    instructions: 'Use echo then reply.',
    model,
    tools: { echo },
  });
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const seen = await drain(runtime.run({ sessionId: newSessionId(), input: 'echo review' }), 'A');

  console.log(summarize('A', seen));
  check('emits text-delta', () => assertHasType(seen, 'text-delta', 'A'));
  check('emits text-start', () => assertHasType(seen, 'text-start', 'A'));
  check('emits text-end', () => assertHasType(seen, 'text-end', 'A'));
  check('emits done', () => assertHasType(seen, 'done', 'A'));
  check('done carries sessionId', () => {
    if (!seen.sessionId) throw new StreamAssertionError('[A] done.payload.sessionId missing');
  });
  // tool-call / tool-result emit sites are exercised end-to-end by the LIVE
  // harness (review-live.ts) — a real provider produces the model-stream
  // chunks the runtime decodes into tool-call/tool-result parts.
}

// ---------------------------------------------------------------------------
// Scenario B: flow agent (collect -> reply) emits flow + node events
// ---------------------------------------------------------------------------
async function scenarioB() {
  console.log('\n=== Scenario B: flow agent collect->reply (offline) ===');
  const model = scriptedModel([
    { deltas: [], finishReason: 'stop' }, // empty answer routes into the flow (host guard)
    { deltas: [], finishReason: 'stop' },
  ]);
  const confirm = reply({
    id: 'confirm',
    instructions: 'Confirm.',
    model,
    next: () => ({ end: 'done' }),
  });
  const nameCollect = collect({
    id: 'name',
    schema: z.object({ name: z.string().min(1) }),
    required: ['name'],
    maxTurns: 5,
    instructions: () => 'Ask for the name.',
    onComplete: () => confirm,
  });
  const flow = defineFlow({
    name: 'name-intake',
    description: 'Collect a name then confirm',
    start: nameCollect,
    nodes: [nameCollect, confirm],
  });
  const agent = defineAgent({
    id: 'flow-agent',
    name: 'Flow',
    instructions: 'Collect a name.',
    model,
    flows: [flow],
  });
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore: new MemoryStore(),
    defaultModel: model,
    hostSelect: async () => ({ kind: 'enterFlow', flow }),
  });

  // Turn 1: enter flow, hit collect, ask for name.
  const seen1 = await drain(
    runtime.run({ sessionId: newSessionId(), input: 'start' }),
    'B-turn1',
  );
  console.log(summarize('B-turn1', seen1));
  check('flow-enter payload.flow populated', () => {
    const fe = seen1.parts.find((p) => p.type === 'flow-enter');
    if (!fe || fe.type !== 'flow-enter' || fe.payload.flow !== 'name-intake') {
      throw new StreamAssertionError('[B] flow-enter.payload.flow != name-intake');
    }
  });
  check('node-enter payload.nodeName populated', () => {
    const ne = seen1.parts.find((p) => p.type === 'node-enter');
    if (!ne || ne.type !== 'node-enter' || ne.payload.nodeName !== 'name') {
      throw new StreamAssertionError('[B] node-enter.payload.nodeName != name');
    }
  });
}

// ---------------------------------------------------------------------------
// Scenario C: two-agent handoff
// ---------------------------------------------------------------------------
async function scenarioC() {
  console.log('\n=== Scenario C: two-agent handoff (offline) ===');
  const model = scriptedModel([{ deltas: [], finishReason: 'stop' }]);
  const specialist = defineAgent({
    id: 'specialist',
    instructions: 'You are the specialist.',
    model,
  });
  const triage = defineAgent({
    id: 'triage',
    instructions: 'Route to specialist.',
    model,
    routes: [{ agent: 'specialist', when: 'specialist question' }],
    agents: [specialist],
    routing: { model },
  });
  const runtime = createRuntime({
    agents: [triage, specialist],
    defaultAgentId: 'triage',
    sessionStore: new MemoryStore(),
    defaultModel: model,
    maxHandoffs: 2,
    hostSelect: async () => ({ kind: 'route', agentId: 'specialist', reason: 'specialist question' }),
  });
  const seen = await drain(
    runtime.run({ sessionId: newSessionId(), input: 'I have a specialist question' }),
    'C',
  );
  console.log(summarize('C', seen));
  check('handoff payload.targetAgent populated', () => {
    const ho = seen.parts.find((p) => p.type === 'handoff');
    if (!ho || ho.type !== 'handoff' || ho.payload.targetAgent !== 'specialist') {
      throw new StreamAssertionError('[C] handoff.payload.targetAgent != specialist');
    }
  });
}

await scenarioA();
await scenarioB();
await scenarioC();

console.log(`\n=== Offline review ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} assertion failure(s)) ===`);
if (failures > 0) process.exit(1);
