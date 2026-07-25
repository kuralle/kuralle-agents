/**
 * Live envelope review — exercises the real emit sites end-to-end against a
 * live provider (OpenAI). Proves the AI SDK decode path produces correct
 * envelopes for text, tool-call/tool-result, flow events, and handoff.
 *
 * Force OpenAI by clearing XAI + Google keys for this process (per CLAUDE.md
 * model-resolution gotcha: resolution prefers xAI -> Google -> OpenAI).
 *
 * Run: bun run packages/core/examples/stream-contract/review-live.ts
 */
import 'dotenv/config';
import { createOpenAI } from '@ai-sdk/openai';
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

// Force OpenAI per the CLAUDE.md model-resolution gotcha.
delete process.env.XAI_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) {
  console.error('OPENAI_API_KEY is required for the live review (set in repo .env)');
  process.exit(1);
}
const MODEL_NAME = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const model = createOpenAI({ apiKey: openaiKey })(MODEL_NAME);
console.log(`Live provider: openai:${MODEL_NAME}`);

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

async function drain(handle: ReturnType<ReturnType<typeof createRuntime>['run']>, origin: string) {
  const seen = makeCollector();
  for await (const part of handle.events) record(seen, part, origin);
  await handle;
  return seen;
}

// ---------------------------------------------------------------------------
// Scenario A: answering agent with a real tool call
// ---------------------------------------------------------------------------
async function scenarioA() {
  console.log('\n=== Scenario A (live): answering agent + tool ===');
  const echo = defineTool({
    name: 'echo',
    description: 'Echo the provided value back as JSON {echoed: value}.',
    input: z.object({ value: z.string() }),
    execute: async ({ value }) => ({ echoed: value }),
  });
  const agent = defineAgent({
    id: 'echo-agent',
    name: 'Echo',
    instructions:
      'You MUST call the echo tool with value="live-review" on the first turn, then state the echoed result in one short sentence.',
    model,
    tools: { echo },
  });
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const seen = await drain(
    runtime.run({ sessionId: newSessionId(), input: 'Please echo the value live-review.' }),
    'live-A',
  );
  console.log(summarize('live-A', seen));
  check('emits text-delta', () => assertHasType(seen, 'text-delta', 'live-A'));
  check('emits tool-call', () => assertHasType(seen, 'tool-call', 'live-A'));
  check('emits tool-result', () => assertHasType(seen, 'tool-result', 'live-A'));
  check('emits done', () => assertHasType(seen, 'done', 'live-A'));
  check('done carries sessionId', () => {
    if (!seen.sessionId) throw new StreamAssertionError('[live-A] done.payload.sessionId missing');
  });
  check('tool-call payload has toolName + args', () => {
    const tc = seen.parts.find((p) => p.type === 'tool-call');
    if (!tc || tc.type !== 'tool-call') throw new Error('no tool-call part');
    if (tc.payload.toolName !== 'echo')
      throw new StreamAssertionError(`toolName='${tc.payload.toolName}'`);
    if ((tc.payload.args as { value?: string }).value !== 'live-review')
      throw new StreamAssertionError(`args=${JSON.stringify(tc.payload.args)}`);
  });
  check('tool-result payload has toolName + result.echoed', () => {
    const tr = seen.parts.find((p) => p.type === 'tool-result');
    if (!tr || tr.type !== 'tool-result') throw new Error('no tool-result part');
    if (tr.payload.toolName !== 'echo')
      throw new StreamAssertionError(`toolName='${tr.payload.toolName}'`);
    if ((tr.payload.result as { echoed?: string }).echoed !== 'live-review')
      throw new StreamAssertionError(`result=${JSON.stringify(tr.payload.result)}`);
  });
}

// ---------------------------------------------------------------------------
// Scenario B: flow agent with collect -> reply across two turns
// ---------------------------------------------------------------------------
async function scenarioB() {
  console.log('\n=== Scenario B (live): flow agent collect -> reply ===');
  const confirm = reply({
    id: 'confirm',
    instructions: 'Confirm the collected name in one short sentence.',
    model,
    next: () => ({ end: 'name-complete' }),
  });
  const nameCollect = collect({
    id: 'name',
    schema: z.object({ name: z.string().min(1) }),
    required: ['name'],
    maxTurns: 5,
    instructions: () => 'Ask for the user name in one short question.',
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
    instructions: 'You collect a name then confirm.',
    model,
    flows: [flow],
  });
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });

  const sid = newSessionId();
  const seen1 = await drain(runtime.run({ sessionId: sid, input: "Let's start." }), 'live-B1');
  console.log(summarize('live-B1', seen1));
  check('turn1 emits flow-enter with payload.flow', () => {
    const fe = seen1.parts.find((p) => p.type === 'flow-enter');
    if (!fe || fe.type !== 'flow-enter' || fe.payload.flow !== 'name-intake')
      throw new StreamAssertionError('[live-B1] flow-enter.payload.flow != name-intake');
  });
  check('turn1 emits node-enter with payload.nodeName=name', () => {
    const ne = seen1.parts.find((p) => p.type === 'node-enter');
    if (!ne || ne.type !== 'node-enter' || ne.payload.nodeName !== 'name')
      throw new StreamAssertionError('[live-B1] node-enter.payload.nodeName != name');
  });

  const seen2 = await drain(runtime.run({ sessionId: sid, input: 'Jordan' }), 'live-B2');
  console.log(summarize('live-B2', seen2));
  check('turn2 emits flow-transition with from=name -> to=confirm', () => {
    const ft = seen2.parts.find((p) => p.type === 'flow-transition');
    if (!ft || ft.type !== 'flow-transition') throw new Error('no flow-transition');
    if (ft.payload.from !== 'name' || ft.payload.to !== 'confirm')
      throw new StreamAssertionError(`from='${ft.payload.from}' to='${ft.payload.to}'`);
  });
}

// ---------------------------------------------------------------------------
// Scenario C: two-agent handoff
// ---------------------------------------------------------------------------
async function scenarioC() {
  console.log('\n=== Scenario C (live): two-agent handoff ===');
  const specialist = defineAgent({
    id: 'specialist',
    instructions: 'You are the specialist. Reply in one short sentence.',
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
  });
  const seen = await drain(
    runtime.run({ sessionId: newSessionId(), input: 'I have a specialist question.' }),
    'live-C',
  );
  console.log(summarize('live-C', seen));
  check('emits handoff with payload.targetAgent=specialist', () => {
    const ho = seen.parts.find((p) => p.type === 'handoff');
    if (!ho || ho.type !== 'handoff' || ho.payload.targetAgent !== 'specialist')
      throw new StreamAssertionError('[live-C] handoff.payload.targetAgent != specialist');
  });
}

await scenarioA();
await scenarioB();
await scenarioC();

console.log(`\n=== Live review ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s)) ===`);
if (failures > 0) process.exit(1);

// Keep a reference so TS import is retained in the type-check view.
void (null as unknown as StreamPart);
