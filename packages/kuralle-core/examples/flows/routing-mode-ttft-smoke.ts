#!/usr/bin/env bun
/**
 * A/B TTFT smoke for `routing.mode: 'tools'` vs the legacy host selector.
 *
 * Isolates the per-turn `generateObject` host-selector cost: a BARE 2-flow agent
 * (no RAG, no skills, no working memory) so the only variable is how flow-entry
 * is decided. Keep turns (plain Q&A that should NOT enter a flow) are timed in
 * both modes; a flow-intent turn confirms `enter_flow` actually fires in tools
 * mode. TTFT = wall-clock from `runtime.run(...)` to the first `text-delta`.
 *
 * Run:  OPENAI_MODEL=gpt-4.1-mini bun examples/flows/routing-mode-ttft-smoke.ts
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
import type { RoutingPolicy } from '../../src/types/route.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../../../.env') });
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY required');
  process.exit(1);
}
const modelName = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const model = createOpenAI({ apiKey })(modelName);

// ── Two flows (descriptions are all the selector / enter_flow tool sees) ──────
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

function buildAgent(routing?: RoutingPolicy) {
  return defineAgent({
    id: 'university',
    model,
    instructions:
      'You are a concise university admissions assistant. Answer the user\'s question directly in 1-2 sentences.',
    flows: [bookAppointment, requestTranscript],
    ...(routing && { routing }),
  });
}

// Plain Q&A — must stay "keep" (no flow entry):
const KEEP_PROMPTS = [
  'What is the application deadline for the fall semester?',
  'Do you offer scholarships for international students?',
  'What documents do I need to apply?',
];
const FLOW_PROMPT = 'I would like to book an appointment with an advisor.';

interface TurnObs {
  ttft: number;
  total: number;
  enteredFlow: string | null;
  calledEnterFlow: boolean;
  text: string;
}

async function runTurn(rt: ReturnType<typeof createRuntime>, sessionId: string, input: string): Promise<TurnObs> {
  const start = Date.now();
  let ttft = -1;
  let enteredFlow: string | null = null;
  let calledEnterFlow = false;
  let text = '';
  const handle = rt.run({ sessionId, input });
  for await (const part of handle.events as AsyncIterable<HarnessStreamPart>) {
    if (part.type === 'text-delta') {
      if (ttft < 0) ttft = Date.now() - start;
      text += part.delta;
    }
    if (part.type === 'flow-enter') enteredFlow = part.flow;
    if (part.type === 'tool-call' && part.toolName === 'enter_flow') calledEnterFlow = true;
  }
  await handle;
  return { ttft: ttft < 0 ? Date.now() - start : ttft, total: Date.now() - start, enteredFlow, calledEnterFlow, text: text.trim() };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

async function measureKeep(label: string, routing?: RoutingPolicy): Promise<number[]> {
  const rt = createRuntime({
    agents: [buildAgent(routing)],
    defaultAgentId: 'university',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const ttfts: number[] = [];
  console.log(`\n### ${label}`);
  // warmup (discarded) — fresh session so no activeFlow carryover
  await runTurn(rt, newSessionId(), 'Hello!');
  for (const p of KEEP_PROMPTS) {
    const o = await runTurn(rt, newSessionId(), p); // fresh session = always a keep/host turn
    const leaked = o.enteredFlow ? `  ⚠️ LEAKED into flow ${o.enteredFlow}` : '';
    console.log(`  keep  TTFT=${String(o.ttft).padStart(5)}ms  total=${String(o.total).padStart(5)}ms  "${o.text.slice(0, 48)}"${leaked}`);
    if (!o.enteredFlow) ttfts.push(o.ttft); // only count genuine keep turns
  }
  return ttfts;
}

async function main() {
  console.log(`Model: openai:${modelName}  ·  bare 2-flow agent (no RAG/skills/memory)`);

  const structured = await measureKeep('structured (legacy selector — current default)');
  const tools = await measureKeep("tools (routing.mode:'tools' — enter_flow on the speaking turn)", { mode: 'tools' });

  // Routing correctness: flow-intent turn in tools mode must enter the flow.
  console.log('\n### routing correctness (tools mode)');
  const rt = createRuntime({
    agents: [buildAgent({ mode: 'tools' })],
    defaultAgentId: 'university',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const fo = await runTurn(rt, newSessionId(), FLOW_PROMPT);
  console.log(`  flow-intent: enter_flow called=${fo.calledEnterFlow}  entered=${fo.enteredFlow ?? 'NONE'}  "${fo.text.slice(0, 56)}"`);

  const ms = median(structured);
  const mt = median(tools);
  console.log('\n────────────────── RESULT ──────────────────');
  console.log(`keep-turn TTFT median  structured: ${ms}ms   (n=${structured.length})`);
  console.log(`keep-turn TTFT median  tools     : ${mt}ms   (n=${tools.length})`);
  console.log(`Δ = ${ms - mt}ms faster  (${(ms / Math.max(mt, 1)).toFixed(2)}×)`);
  const routedOk = fo.calledEnterFlow && fo.enteredFlow === 'book-advisor-appointment';
  console.log(`routing correctness: ${routedOk ? 'PASS — enter_flow fired + entered booking' : 'FAIL — flow not entered'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
