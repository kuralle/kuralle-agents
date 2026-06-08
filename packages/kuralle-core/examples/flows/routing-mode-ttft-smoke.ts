#!/usr/bin/env bun
/**
 * TTFT smoke for derived host routing vs legacy selector (commit 66798db).
 *
 * Isolates keep-turn cost: bare 2-flow answering agent, no RAG/skills/memory.
 * Derived routing folds flow entry into the speaking turn + concurrent guard;
 * legacy paid an upfront generateObject selector on every keep turn.
 *
 * Run: OPENAI_MODEL=gpt-4.1-mini bun examples/flows/routing-mode-ttft-smoke.ts
 */
import { createOpenAI } from '@ai-sdk/openai';
import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/authoring/nodes.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../../../.env') });
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY required');
  process.exit(1);
}
const modelName = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const model = createOpenAI({ apiKey })(modelName);

const bookStart = reply({
  id: 'book-start',
  instructions: 'Say: "Sure — what day works best for your advisor appointment?"',
  next: () => ({ end: 'collected' }),
});
const bookAppointment = defineFlow({
  name: 'book-advisor-appointment',
  description: 'Book an appointment with an academic advisor',
  start: bookStart,
  nodes: [bookStart],
});
const transcriptStart = reply({
  id: 'transcript-start',
  instructions: 'Say: "I can help with that. Which email should the transcript go to?"',
  next: () => ({ end: 'collected' }),
});
const requestTranscript = defineFlow({
  name: 'request-transcript',
  description: 'Request an official copy of the academic transcript',
  start: transcriptStart,
  nodes: [transcriptStart],
});

const billingChild = defineAgent({
  id: 'billing',
  instructions: 'You handle billing questions briefly.',
  model,
});

function buildAnsweringAgent() {
  return defineAgent({
    id: 'university',
    model,
    instructions:
      "You are a concise university admissions assistant. Answer the user's question directly in 1-2 sentences.",
    flows: [bookAppointment, requestTranscript],
    routes: [{ agent: 'billing', when: 'billing or payment questions' }],
    agents: [billingChild],
  });
}

const KEEP_PROMPTS = [
  'What is the application deadline for the fall semester?',
  'Do you offer scholarships for international students?',
  'What documents do I need to apply?',
];
const FLOW_PROMPT = 'I would like to book an appointment with an advisor.';
const TRANSFER_PROMPT = 'I need help with my tuition payment balance.';

interface TurnObs {
  ttft: number;
  total: number;
  enteredFlow: string | null;
  calledEnterFlow: boolean;
  calledTransfer: boolean;
  handoffTo: string | null;
  text: string;
}

async function runTurn(
  rt: ReturnType<typeof createRuntime>,
  sessionId: string,
  input: string,
): Promise<TurnObs> {
  const start = Date.now();
  let ttft = -1;
  let enteredFlow: string | null = null;
  let calledEnterFlow = false;
  let calledTransfer = false;
  let handoffTo: string | null = null;
  let text = '';
  const handle = rt.run({ sessionId, input });
  for await (const part of handle.events as AsyncIterable<HarnessStreamPart>) {
    if (part.type === 'text-delta') {
      if (ttft < 0) ttft = Date.now() - start;
      text += part.delta;
    }
    if (part.type === 'flow-enter') enteredFlow = part.flow;
    if (part.type === 'tool-call' && part.toolName === 'enter_flow') calledEnterFlow = true;
    if (part.type === 'tool-call' && part.toolName === 'transfer_to_agent') calledTransfer = true;
    if (part.type === 'handoff') handoffTo = part.targetAgent;
  }
  await handle;
  return {
    ttft: ttft < 0 ? Date.now() - start : ttft,
    total: Date.now() - start,
    enteredFlow,
    calledEnterFlow,
    calledTransfer,
    handoffTo,
    text: text.trim(),
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

async function measureKeep(label: string): Promise<number[]> {
  const rt = createRuntime({
    agents: [buildAnsweringAgent(), billingChild],
    defaultAgentId: 'university',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const ttfts: number[] = [];
  console.log(`\n### ${label}`);
  await runTurn(rt, newSessionId(), 'Hello!');
  for (const p of KEEP_PROMPTS) {
    const o = await runTurn(rt, newSessionId(), p);
    const leaked = o.enteredFlow ? `  ⚠️ LEAKED into flow ${o.enteredFlow}` : '';
    console.log(
      `  keep  TTFT=${String(o.ttft).padStart(5)}ms  total=${String(o.total).padStart(5)}ms  "${o.text.slice(0, 48)}"${leaked}`,
    );
    if (!o.enteredFlow) ttfts.push(o.ttft);
  }
  return ttfts;
}

async function main() {
  console.log(`Model: openai:${modelName}  ·  derived routing (ADR 0007)`);
  console.log('Legacy baseline (66798db): keep-turn TTFT median ~2874ms with structured selector');

  const derived = await measureKeep('derived routing (host-control tools + guard)');

  console.log('\n### routing correctness');
  const rt = createRuntime({
    agents: [buildAnsweringAgent(), billingChild],
    defaultAgentId: 'university',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const fo = await runTurn(rt, newSessionId(), FLOW_PROMPT);
  console.log(
    `  flow-intent: enter_flow=${fo.calledEnterFlow}  entered=${fo.enteredFlow ?? 'NONE'}  "${fo.text.slice(0, 56)}"`,
  );
  const to = await runTurn(rt, newSessionId(), TRANSFER_PROMPT);
  console.log(
    `  transfer-intent: transfer_to_agent=${to.calledTransfer}  handoff=${to.handoffTo ?? 'NONE'}`,
  );

  const md = median(derived);
  console.log('\n────────────────── RESULT ──────────────────');
  console.log(`keep-turn TTFT median  derived: ${md}ms   (n=${derived.length})`);
  console.log(`legacy structured (~66798db): ~2874ms (from prior smoke)`);
  console.log(`Δ vs legacy ≈ ${2874 - md}ms faster`);
  const flowOk = fo.calledEnterFlow && fo.enteredFlow === 'book-advisor-appointment';
  const xferOk = to.calledTransfer || to.handoffTo === 'billing';
  console.log(`enter_flow: ${flowOk ? 'PASS' : 'FAIL'}`);
  console.log(`transfer_to_agent: ${xferOk ? 'PASS' : 'FAIL'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
