/**
 * Pipeline Verification + Latency Benchmark (v2)
 */

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { defineAgent } from '../src/authoring/defineAgent.js';
import { collect, defineFlow, reply } from '../src/authoring/nodes.js';
import { createRuntime } from '../src/runtime/Runtime.js';
import { MemoryStore } from '../src/session/stores/MemoryStore.js';
import { newSessionId } from '../src/runtime/openRun.js';
import { createInMemoryKnowledgeConfig } from '../src/runtime/grounding/inMemoryKnowledge.js';
import type { HarnessStreamPart } from '../src/types/stream.js';
import type { Session } from '../src/types/session.js';
import { loadExampleEnv } from './_shared/v2Runner.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
loadExampleEnv(import.meta.url);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

interface TimedEvent {
  idx: number;
  type: string;
  elapsed: number;
  part: HarnessStreamPart;
}

interface StreamMetrics {
  label: string;
  totalEvents: number;
  totalMs: number;
  ttft: number;
  timeToDone: number;
  textDeltaCount: number;
  events: TimedEvent[];
  fullText: string;
}

async function collectStreamTimed(
  label: string,
  run: () => ReturnType<ReturnType<typeof createRuntime>['run']>,
): Promise<StreamMetrics> {
  const start = performance.now();
  const events: TimedEvent[] = [];
  let idx = 0;

  const handle = run();
  for await (const part of handle.events) {
    const now = performance.now();
    events.push({
      idx: idx++,
      type: part.type,
      elapsed: Math.round((now - start) * 100) / 100,
      part,
    });
  }
  await handle;

  const end = performance.now();
  const firstTextDelta = events.find((e) => e.type === 'text-delta');
  const doneEvent = events.find((e) => e.type === 'done');
  const fullText = events
    .filter((e): e is TimedEvent & { part: Extract<HarnessStreamPart, { type: 'text-delta' }> } => e.type === 'text-delta')
    .map((e) => e.part.delta)
    .join('');

  return {
    label,
    totalEvents: events.length,
    totalMs: Math.round((end - start) * 100) / 100,
    ttft: firstTextDelta ? Math.round(firstTextDelta.elapsed * 100) / 100 : -1,
    timeToDone: doneEvent ? Math.round(doneEvent.elapsed * 100) / 100 : -1,
    textDeltaCount: events.filter((e) => e.type === 'text-delta').length,
    events,
    fullText,
  };
}

const logPath = join(currentDir, 'pipeline-verification.log');
const logLines: string[] = [];
function log(line: string) {
  logLines.push(line);
}
function logSection(title: string) {
  log('');
  log('═'.repeat(80));
  log(`  ${title}`);
  log('═'.repeat(80));
}
function flushLog() {
  fs.writeFileSync(logPath, logLines.join('\n') + '\n', 'utf-8');
}

function logMetrics(m: StreamMetrics) {
  log(`\n  ┌── ${m.label} (${m.totalEvents} events) ──`);
  for (const e of m.events) {
    log(`  [${String(e.idx).padStart(3)}] +${String(e.elapsed).padStart(8)}ms  ${e.type}`);
  }
  log(`  │ TTFT: ${m.ttft >= 0 ? m.ttft + 'ms' : 'n/a'}  done: ${m.timeToDone >= 0 ? m.timeToDone + 'ms' : 'n/a'}  total: ${m.totalMs}ms`);
  log(`  └── End ──`);
}

const latencyTable: Array<{ label: string; ttft: number; done: number; total: number }> = [];
function recordLatency(m: StreamMetrics) {
  latencyTable.push({ label: m.label, ttft: m.ttft, done: m.timeToDone, total: m.totalMs });
}

const model = openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

async function testSessionPersistence() {
  console.log('\n═══ Test 1: Session persistence ═══');
  logSection('Test 1: Session persistence');

  let storeGetCalls = 0;
  let storeSaveCalls = 0;
  const baseStore = new MemoryStore();
  const trackedStore = {
    get: async (id: string) => {
      storeGetCalls++;
      return baseStore.get(id);
    },
    save: async (session: Session) => {
      storeSaveCalls++;
      return baseStore.save(session);
    },
    delete: async (id: string) => baseStore.delete(id),
    list: async (userId?: string) => baseStore.list(userId),
  };

  const agent = defineAgent({
    id: 'cache-test-agent',
    name: 'Cache Test',
    model,
    instructions: 'Answer briefly in one sentence.',
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: model,
    sessionStore: trackedStore,
  });

  const sessionId = newSessionId();
  storeGetCalls = 0;
  storeSaveCalls = 0;

  const m1 = await collectStreamTimed('T1: Cold session', () => runtime.run({ input: 'What is 2+2?', sessionId }));
  logMetrics(m1);
  recordLatency(m1);
  assert(m1.fullText.length > 0, 'Turn 1 produces text');

  storeGetCalls = 0;
  const m2 = await collectStreamTimed('T1: Warm session', () =>
    runtime.run({ input: 'And what is 3+3?', sessionId }),
  );
  logMetrics(m2);
  recordLatency(m2);
  assert(m2.fullText.length > 0, 'Turn 2 produces text');
  assert(storeSaveCalls > 0, `Session saved (${storeSaveCalls})`);
}

async function testStreamHooks() {
  console.log('\n═══ Test 2: onStreamPart hook ═══');
  logSection('Test 2: onStreamPart hook');

  const agent = defineAgent({
    id: 'hook-test',
    instructions: 'Answer in one sentence.',
    model,
  });

  let hookCalls = 0;
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: model,
    hooks: { onStreamPart: async () => { hookCalls++; } },
  });

  const m = await collectStreamTimed('T2: With hook', () => runtime.run({ input: 'Say hello world' }));
  logMetrics(m);
  recordLatency(m);
  assert(hookCalls > 0, `Hook fired (${hookCalls})`);
}

async function testEventSequence() {
  console.log('\n═══ Test 3: Event sequence ═══');
  logSection('Test 3: Event sequence');

  const agent = defineAgent({
    id: 'sequence-test',
    instructions: 'Answer briefly.',
    model,
  });
  const runtime = createRuntime({ agents: [agent], defaultAgentId: agent.id, defaultModel: model });
  const m = await collectStreamTimed('T3: Free conversation', () => runtime.run({ input: 'Hi there' }));
  logMetrics(m);
  recordLatency(m);

  const types = m.events.map((e) => e.type);
  assert(types.includes('text-delta'), 'Has text-delta');
  assert(types.includes('done'), 'Has done');
  assert(types.lastIndexOf('done') === types.length - 1, 'done is last');
}

async function testFlowCollect() {
  console.log('\n═══ Test 4: Flow collect ═══');
  logSection('Test 4: Flow collect');

  const done = reply({ id: 'done', instructions: 'Thank them.', next: () => ({ end: 'completed' }) });
  const askPhone = collect({
    id: 'ask_phone',
    schema: z.object({ phone: z.string().min(1) }),
    required: ['phone'],
    instructions: () => 'Ask for phone number.',
    onComplete: () => done,
  });
  const askName = collect({
    id: 'ask_name',
    schema: z.object({ name: z.string().min(1) }),
    required: ['name'],
    instructions: () => 'Ask for full name.',
    onComplete: () => askPhone,
  });

  const agent = defineAgent({
    id: 'flow-test',
    model,
    flows: [
      defineFlow({
        name: 'intake',
        description: 'Name and phone',
        start: askName,
        nodes: [askName, askPhone, done],
      }),
    ],
  });

  const runtime = createRuntime({ agents: [agent], defaultAgentId: agent.id, defaultModel: model });
  const sessionId = newSessionId();

  const m1 = await collectStreamTimed('T4.1: Flow start', () =>
    runtime.run({ input: 'Book an appointment', sessionId }),
  );
  recordLatency(m1);
  assert(m1.events.some((e) => e.type === 'flow-enter'), 'Flow entered');

  const m2 = await collectStreamTimed('T4.2: Name', () => runtime.run({ input: 'Jordan Lee', sessionId }));
  recordLatency(m2);
  assert(m2.fullText.length > 0, 'Name turn produces text');
}

async function testKnowledgeRetrieve() {
  console.log('\n═══ Test 5: Knowledge autoRetrieve ═══');
  logSection('Test 5: Knowledge autoRetrieve');

  const agent = defineAgent({
    id: 'gather-test',
    instructions: 'Use retrieved context to answer briefly.',
    model,
    knowledge: { autoRetrieve: true },
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: model,
    knowledge: createInMemoryKnowledgeConfig([
      { text: 'The capital of France is Paris. Population ~2.1M.' },
    ]),
  });

  const m = await collectStreamTimed('T5: With knowledge', () =>
    runtime.run({ input: 'What is the capital of France?' }),
  );
  logMetrics(m);
  recordLatency(m);
  assert(m.fullText.toLowerCase().includes('paris'), 'Model used retrieved context');
}

async function testMultiTurn() {
  console.log('\n═══ Test 6: Multi-turn integration ═══');
  logSection('Test 6: Multi-turn');

  const agent = defineAgent({
    id: 'math',
    instructions: 'Answer briefly with the number.',
    model,
  });
  const runtime = createRuntime({ agents: [agent], defaultAgentId: agent.id, defaultModel: model });
  const sessionId = newSessionId();

  const m1 = await collectStreamTimed('T6.1: 5*7', () =>
    runtime.run({ input: 'What is 5 times 7?', sessionId }),
  );
  recordLatency(m1);
  assert(m1.fullText.includes('35'), '35 in response');

  const m2 = await collectStreamTimed('T6.2: double', () =>
    runtime.run({ input: 'Now double that result', sessionId }),
  );
  recordLatency(m2);
  assert(m2.fullText.includes('70'), '70 in response');
}

async function main() {
  console.log('Pipeline Verification + Latency Benchmark (v2)');
  log(`Timestamp: ${new Date().toISOString()}`);

  await testSessionPersistence();
  await testStreamHooks();
  await testEventSequence();
  await testFlowCollect();
  await testKnowledgeRetrieve();
  await testMultiTurn();

  console.log('\n═══ LATENCY SUMMARY ═══');
  for (const r of latencyTable) {
    console.log(`  ${r.label.padEnd(40)} ttft=${r.ttft}ms total=${r.total}ms`);
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  log(`\nResults: ${passed} passed, ${failed} failed`);
  flushLog();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  flushLog();
  process.exit(1);
});
