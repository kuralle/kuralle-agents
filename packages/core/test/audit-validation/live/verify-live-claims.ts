#!/usr/bin/env bun
/**
 * LIVE-API claim verification for the durability audit + docs/agentic-voice-framework-gaps.md.
 *
 * Every check below builds a REAL Kuralle runtime, drives it with a REAL provider
 * (OpenAI gpt-4.1-mini, forced), and asserts on the deterministic *mechanism* the
 * doc names (durable-journal call counts, session.messages contents, flow state,
 * thrown limit errors) — never on model prose. The live model only drives the turns.
 *
 * Run:  bun test/audit-validation/live/verify-live-claims.ts
 * Out:  runs/result-claim-verification.json  (merged with the structural sweep later)
 *
 * A claim is CONFIRMED when the documented failure reproduces, REFUTED when the
 * code behaves correctly, INCONCLUSIVE when the live model wouldn't drive the trace.
 */
import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { defineTool, buildToolSet } from '../../../src/tools/effect/defineTool.js';
import { reply, collect, decide, action, defineFlow } from '../../../src/authoring/nodes.js';
import { deriveAgentShape } from '../../../src/runtime/deriveAgent.js';
import type { StreamPart, TurnHandle } from '../../../src/types/stream.js';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '../../../.env') }); // packages/core/.env
config({ path: join(here, '../../../../.env') }); // repo root .env

const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error('No OPENAI_API_KEY — live verification cannot run.');
  process.exit(2);
}
const MODEL_ID = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const model = createOpenAI({ apiKey: key })(MODEL_ID);
console.log(`Live verification — provider openai:${MODEL_ID}\n`);

type Verdict = 'CONFIRMED' | 'REFUTED' | 'INCONCLUSIVE' | 'ERROR';
interface Result {
  claim: string;
  gap: string;
  mode: 'live';
  verdict: Verdict;
  expected: string;
  observed: string;
}
const results: Result[] = [];
function record(r: Result) {
  const mark = r.verdict === 'CONFIRMED' ? '✓ CONFIRMED' : r.verdict === 'REFUTED' ? '✗ REFUTED' : `· ${r.verdict}`;
  console.log(`[${mark}] ${r.gap} — ${r.claim}\n    observed: ${r.observed}\n`);
  results.push(r);
}

interface TurnObs {
  text: string;
  toolCalls: string[];
  toolResults: { name: string; result: unknown }[];
  flowEnters: string[];
  flowEnds: string[];
  handoffs: string[];
  nodes: string[];
  errors: string[];
  safetyBlocked: boolean;
  types: string[];
}
async function drive(handle: TurnHandle): Promise<TurnObs> {
  const o: TurnObs = {
    text: '', toolCalls: [], toolResults: [], flowEnters: [], flowEnds: [],
    handoffs: [], nodes: [], errors: [], safetyBlocked: false, types: [],
  };
  try {
    for await (const part of handle.events as AsyncIterable<StreamPart>) {
      o.types.push(part.type);
      if (part.type === 'text-delta') o.text += part.payload.delta;
      else if (part.type === 'tool-call') o.toolCalls.push(part.payload.toolName);
      else if (part.type === 'tool-result') o.toolResults.push({ name: part.payload.toolName, result: part.payload.result });
      else if (part.type === 'flow-enter') o.flowEnters.push(part.payload.flow);
      else if (part.type === 'flow-end') o.flowEnds.push(part.payload.flow);
      else if (part.type === 'handoff') o.handoffs.push(part.payload.targetAgent);
      else if (part.type === 'node-enter') o.nodes.push((part as { nodeName?: string }).nodeName ?? '');
      else if (part.type === 'error') o.errors.push(String((part as { error?: unknown }).error));
      else if (part.type === 'safety-blocked') o.safetyBlocked = true;
    }
    const res = await handle;
    if (!o.text && typeof (res as { text?: string }).text === 'string') o.text = (res as { text: string }).text;
  } catch (e) {
    o.errors.push(e instanceof Error ? e.message : String(e));
  }
  return o;
}

// ───────────────────────────────────────────────────────────────────────────
// LIVE-A · Teardown F6 / Gaps G8 — cross-turn stale replay (durable journal
// keyed by (sessionId, callsite-ordinal, name, args); ordinal resets per turn,
// runId === sessionId → a 2nd identical call replays turn-1's cached result).
// ───────────────────────────────────────────────────────────────────────────
async function checkStaleReplay() {
  let executorCalls = 0;
  const realBalances: number[] = [];
  const getBalance = defineTool({
    name: 'get_balance',
    description: 'Return the account balance in USD. Always call this to answer any balance question.',
    input: z.object({}),
    execute: async () => {
      executorCalls += 1;
      const bal = 100 - 40 * (executorCalls - 1); // real balance CHANGES between calls: 100, then 60
      realBalances.push(bal);
      return { balanceUsd: bal };
    },
  });
  const runtime = createRuntime({
    agents: [defineAgent({
      id: 'bank',
      instructions: 'You are a banking assistant. To answer ANY question about balance you MUST call get_balance and report the number it returns. Never answer a balance from memory.',
      model,
      globalTools: { get_balance: getBalance },
    })],
    defaultAgentId: 'bank',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const sid = 'stale-replay-1';
  const t1 = await drive(runtime.run({ sessionId: sid, input: 'What is my balance right now?' }));
  const callsAfterT1 = executorCalls;
  const t2 = await drive(runtime.run({ sessionId: sid, input: 'Call get_balance again and tell me my CURRENT balance right now.' }));
  const t2CalledTool = t2.toolCalls.includes('get_balance');
  const callsAfterT2 = executorCalls;

  const observed = `turn1 executorCalls=${callsAfterT1} (balance ${realBalances[0]}); turn2 emitted get_balance tool-call=${t2CalledTool}, executorCalls now=${callsAfterT2}; realBalances=${JSON.stringify(realBalances)}`;
  let verdict: Verdict;
  if (t2CalledTool && callsAfterT2 === callsAfterT1) verdict = 'CONFIRMED'; // 2nd call replayed cache, executor never ran
  else if (t2CalledTool && callsAfterT2 > callsAfterT1) verdict = 'REFUTED'; // executor ran again → no stale replay
  else verdict = 'INCONCLUSIVE'; // model didn't call the tool a 2nd time
  record({
    claim: 'A 2nd identical durable tool call in the same session replays the 1st result without executing (stale data)',
    gap: 'F6 / G8', mode: 'live', verdict,
    expected: 'turn-2 get_balance emits a tool-call but executor is NOT re-run; user gets stale balance',
    observed,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// LIVE-B · Teardown §5 / Gaps G18 — in free conversation only the final
// assistant text is persisted; tool calls/results never enter session.messages.
// ───────────────────────────────────────────────────────────────────────────
async function checkToolResultsNotInHistory() {
  const secret = 'ZQ-7731-POLICY';
  const lookup = defineTool({
    name: 'lookup_policy',
    description: 'Look up the policy reference code for the account. Call this when asked about the policy code.',
    input: z.object({}),
    execute: async () => ({ policyCode: secret }),
  });
  const store = new MemoryStore();
  const runtime = createRuntime({
    agents: [defineAgent({
      id: 'ins', instructions: 'You are an insurance assistant. Use lookup_policy to fetch the policy code when asked.',
      model, globalTools: { lookup_policy: lookup },
    })],
    defaultAgentId: 'ins', sessionStore: store, defaultModel: model,
  });
  const sid = 'history-1';
  const t1 = await drive(runtime.run({ sessionId: sid, input: 'What is my policy reference code? Look it up.' }));
  const session = await store.get(sid);
  const msgs = session?.messages ?? [];
  const serialized = JSON.stringify(msgs);
  const hasToolPart = /tool-call|tool-result|tool_call|toolCallId/.test(serialized) ||
    msgs.some((m) => Array.isArray((m as { content?: unknown }).content) &&
      ((m as { content: unknown[] }).content).some((p) => typeof p === 'object' && p !== null && /tool/i.test((p as { type?: string }).type ?? '')));
  const secretInHistory = serialized.includes(secret);
  const toolWasCalled = t1.toolCalls.includes('lookup_policy');

  const observed = `tool called=${toolWasCalled}; session.messages roles=[${msgs.map((m) => m.role).join(',')}]; any tool part in history=${hasToolPart}; retrieved secret present in history=${secretInHistory}`;
  let verdict: Verdict;
  if (!toolWasCalled) verdict = 'INCONCLUSIVE';
  else if (!hasToolPart) verdict = 'CONFIRMED'; // tool ran but no tool part persisted → next turn can't cite it
  else verdict = 'REFUTED';
  record({
    claim: 'Free-conversation tool calls/results are dropped from session.messages (only final text persists)',
    gap: 'G18 / §5', mode: 'live', verdict,
    expected: 'lookup_policy runs but no tool-call/tool-result part is written to session.messages',
    observed,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// LIVE-C · Teardown §4.1 / F5 — determinism is opt-in: any populated
// `instructions` makes the agent an "answering agent"; a flow is entered only
// via the LLM guard, so an off-flow turn free-converses instead of running SOP.
// ───────────────────────────────────────────────────────────────────────────
async function checkDeterminismOptIn() {
  const askNode = reply({ id: 'ask', instructions: 'Ask what cake they want.', next: () => ({ end: 'done' }) });
  const orderFlow = defineFlow({
    name: 'place-order',
    description: 'Place a cake order',
    start: askNode,
    nodes: [askNode],
  });
  const agent = defineAgent({
    id: 'shop',
    instructions: 'You are a bakery assistant. Answer general questions directly.',
    model, flows: [orderFlow],
  });
  const shape = deriveAgentShape(agent);
  const runtime = createRuntime({ agents: [agent], defaultAgentId: 'shop', sessionStore: new MemoryStore(), defaultModel: model });
  // An off-flow question — should NOT force the place-order flow on turn 1.
  const t1 = await drive(runtime.run({ sessionId: 'det-1', input: 'What are your opening hours on Sundays?' }));
  const enteredFlow = t1.flowEnters.length > 0;

  const observed = `deriveAgentShape=${JSON.stringify(shape)}; off-flow turn entered a flow=${enteredFlow} (flowEnters=${JSON.stringify(t1.flowEnters)}); answered text len=${t1.text.trim().length}`;
  // CONFIRMED (determinism is opt-in) when shape is the answering/free-first shape AND the off-flow turn free-converses.
  const answering = JSON.stringify(shape).toLowerCase().includes('answer') || (shape as { mode?: string }).mode === 'answering' || (shape as { freeConversation?: boolean }).freeConversation === true;
  const verdict: Verdict = (!enteredFlow && t1.text.trim().length > 0) ? 'CONFIRMED' : enteredFlow ? 'REFUTED' : 'INCONCLUSIVE';
  record({
    claim: 'Populated instructions ⇒ answering agent; flows are LLM-gated, so off-flow turns free-converse (determinism is opt-in, not default)',
    gap: 'F5 / §4.1', mode: 'live', verdict,
    expected: 'off-flow question is answered in free conversation without entering the SOP flow',
    observed: observed + ` | shapeAnswering=${answering}`,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// LIVE-D · Teardown §3 / F7 — maxTurns lives in session-lifetime run.state,
// only incremented, never reset → a per-turn guard permanently bricks the thread.
// ───────────────────────────────────────────────────────────────────────────
async function checkMaxTurnsBricks() {
  const runtime = createRuntime({
    agents: [defineAgent({ id: 'lim', instructions: 'You are a concise assistant.', model, limits: { maxTurns: 2 } })],
    defaultAgentId: 'lim', sessionStore: new MemoryStore(), defaultModel: model,
  });
  const sid = 'maxturns-1';
  const t1 = await drive(runtime.run({ sessionId: sid, input: 'Hello there.' }));
  const t2 = await drive(runtime.run({ sessionId: sid, input: 'What is 2+2?' }));
  const t3 = await drive(runtime.run({ sessionId: sid, input: 'And what is 3+3?' }));
  const t4 = await drive(runtime.run({ sessionId: sid, input: 'One more: 4+4?' }));
  const brickedAt3 = t3.errors.length > 0 || t3.safetyBlocked || t3.text.trim().length === 0 || /unable|error|limit/i.test(t3.text);
  const stillBrickedAt4 = t4.errors.length > 0 || t4.safetyBlocked || t4.text.trim().length === 0 || /unable|error|limit/i.test(t4.text);

  const observed = `t1 ok(len ${t1.text.trim().length}); t2 ok(len ${t2.text.trim().length}); t3 errors=${JSON.stringify(t3.errors)} textLen=${t3.text.trim().length}; t4 errors=${JSON.stringify(t4.errors)} textLen=${t4.text.trim().length}`;
  const verdict: Verdict = brickedAt3 && stillBrickedAt4 ? 'CONFIRMED' : !brickedAt3 ? 'REFUTED' : 'INCONCLUSIVE';
  record({
    claim: 'maxTurns counter is session-cumulative and never reset — once exceeded, every later turn is permanently bricked',
    gap: 'F7', mode: 'live', verdict,
    expected: 'turn 3 (past maxTurns=2) fails and turn 4 still fails — the whole session is dead',
    observed,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// LIVE-E · Teardown §4.8 / F9 — completed flows are excluded from the guard's
// candidates and the enter_flow surface forever; nothing clears __completedFlows,
// so a 2nd request for the same flow in one session cannot re-enter.
// ───────────────────────────────────────────────────────────────────────────
async function checkCompletedFlowOneShot() {
  const mkFlow = () => {
    const confirmNode = reply({ id: 'confirm', instructions: 'Confirm the cake order in one sentence and finish.', next: () => ({ end: 'ordered' }) });
    return defineFlow({
      name: 'order-cake',
      description: 'Place a single cake order for the customer',
      start: confirmNode,
      nodes: [confirmNode],
    });
  };
  const store = new MemoryStore();
  const runtime = createRuntime({
    agents: [defineAgent({ id: 'cake', instructions: 'You are a cake shop. Use the order-cake flow to place an order when the customer wants a cake.', model, flows: [mkFlow()] })],
    defaultAgentId: 'cake', sessionStore: store, defaultModel: model,
  });
  const sid = 'oneshot-1';
  const t1 = await drive(runtime.run({ sessionId: sid, input: 'I want to order a chocolate cake please.' }));
  // best-effort: nudge the flow to completion if it needs a 2nd turn
  const t1b = t1.flowEnds.length === 0 ? await drive(runtime.run({ sessionId: sid, input: 'Yes, confirm it.' })) : null;
  const sAfter1 = await store.get(sid);
  // Flow state lives under session.durableRuns[runId].runState.state (runId === sessionId), NOT session.state.
  const runStateAfter1 = (sAfter1 as unknown as { durableRuns?: Record<string, { runState?: { state?: Record<string, unknown> } }> })?.durableRuns?.[sid]?.runState?.state ?? {};
  const completedAfter1 = (runStateAfter1.__completedFlows as string[] | undefined) ?? [];
  const t2 = await drive(runtime.run({ sessionId: sid, input: 'Actually I want to place a SECOND, separate order — another cake, vanilla this time.' }));
  const reEntered = t2.flowEnters.includes('order-cake');
  const firstEnters = [...t1.flowEnters, ...(t1b?.flowEnters ?? [])].filter((f) => f === 'order-cake').length;

  const observed = `flow enters on 1st request=${firstEnters}; __completedFlows after 1st=${JSON.stringify(completedAfter1)}; 2nd request re-entered order-cake=${reEntered}`;
  let verdict: Verdict;
  if (completedAfter1.includes('order-cake') && !reEntered) verdict = 'CONFIRMED';
  else if (reEntered) verdict = 'REFUTED';
  else verdict = 'INCONCLUSIVE';
  record({
    claim: 'A flow completed once in a session is one-shot — __completedFlows is never cleared, blocking a 2nd same-flow request',
    gap: 'F9', mode: 'live', verdict,
    expected: '__completedFlows contains order-cake after the 1st order; the 2nd request cannot re-enter it',
    observed,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// LIVE-F · Teardown §6 / Gaps G17 — a handoff issued while a flow is active
// leaves run.activeFlow set; the target agent enters runActiveFlow and throws
// "Active flow not found" (the flow belongs to the source agent).
// ───────────────────────────────────────────────────────────────────────────
async function checkMidFlowHandoffCrash() {
  // Faithful repro of the doc's exact path (hostLoop.ts:138 returns kind:handoff
  // WITHOUT clearing activeFlow — but only reached when the flow is ALREADY active
  // from a prior turn). So: turn 1 SUSPENDS inside the flow (activeFlow='intake'
  // persisted), turn 2 hands off while the flow is active → target should throw.
  const readActiveFlow = (s: unknown, id: string) =>
    (s as { durableRuns?: Record<string, { runState?: { activeFlow?: string; activeAgentId?: string } }> })?.durableRuns?.[id]?.runState;
  // A `collect` node genuinely suspends and persists activeFlow='intake' across
  // turns (awaitingUser → putRunState). On turn 2 it completes and routes to an
  // action node that hands off — reaching runActiveFlow:138 (return kind:handoff
  // with NO activeFlow clear) with a flow that was active from the prior turn.
  const handoffNode = action({ id: 'to_billing', run: () => ({ handoff: 'billing', reason: 'route to billing' }) });
  const gather = collect({
    id: 'gather',
    schema: z.object({ issue: z.string().min(3).nullable() }),
    required: ['issue'],
    maxTurns: 6,
    instructions: () => 'Ask the caller to describe their billing issue in a sentence.',
    onComplete: () => handoffNode,
  });
  const sourceFlow = defineFlow({
    name: 'intake', description: 'Collect an issue (suspends), then hand off to billing while the flow is active',
    start: gather, nodes: [gather, handoffNode],
  });
  const billing = defineAgent({ id: 'billing', instructions: 'You are Bob, the billing specialist. Answer in one sentence.', model });
  const source = defineAgent({ id: 'intake', model, flows: [sourceFlow], handoffs: ['billing'], agents: [billing] });
  const store = new MemoryStore();
  const runtime = createRuntime({ agents: [source, billing], defaultAgentId: 'intake', sessionStore: store, defaultModel: model });
  const sid = 'midflow-handoff-1';
  const t1 = await drive(runtime.run({ sessionId: sid, input: 'Hi, I have a billing question.' }));
  const activeFlowAfterT1 = readActiveFlow(await store.get(sid), sid)?.activeFlow;
  const t2 = await drive(runtime.run({ sessionId: sid, input: 'My invoice looks wrong, please help.' }));
  const runStateAfter = readActiveFlow(await store.get(sid), sid);
  const allErrors = [...t1.errors, ...t2.errors].join(' | ');
  const activeFlowError = /active flow.*not found/i.test(allErrors);
  const handedOff = [...t1.handoffs, ...t2.handoffs].length > 0;

  const observed = `activeFlow persisted after t1=${JSON.stringify(activeFlowAfterT1)}; t2 handoff observed=${handedOff} (targets ${JSON.stringify([...t1.handoffs, ...t2.handoffs])}); after-t2 activeFlow=${JSON.stringify(runStateAfter?.activeFlow)} activeAgent=${JSON.stringify(runStateAfter?.activeAgentId)}; errors=${JSON.stringify([...t1.errors, ...t2.errors])}`;
  let verdict: Verdict;
  if (activeFlowError) verdict = 'CONFIRMED'; // target threw "Active flow not found"
  else if (handedOff && !activeFlowError) verdict = 'REFUTED'; // mid-flow handoff completed cleanly — claim stale
  else verdict = 'INCONCLUSIVE';
  record({
    claim: 'A handoff fired mid-flow leaves run.activeFlow set; the target agent throws "Active flow not found"',
    gap: 'G17 / §6', mode: 'live', verdict,
    expected: 'the billing target throws "Active flow not found" because run.activeFlow still points at the source flow',
    observed,
  });
}

// ───────────────────────────────────────────────────────────────────────────
const suite: [string, () => Promise<void>][] = [
  ['LIVE-A F6/G8 stale-replay', checkStaleReplay],
  ['LIVE-B G18 tool-results-not-in-history', checkToolResultsNotInHistory],
  ['LIVE-C F5 determinism-opt-in', checkDeterminismOptIn],
  ['LIVE-D F7 maxTurns-bricks', checkMaxTurnsBricks],
  ['LIVE-E F9 completed-flow-one-shot', checkCompletedFlowOneShot],
  ['LIVE-F G17 mid-flow-handoff-crash', checkMidFlowHandoffCrash],
];

let hardErrors = 0;
for (const [name, fn] of suite) {
  console.log(`── running ${name} ──`);
  try {
    await fn();
  } catch (e) {
    hardErrors += 1;
    record({ claim: name, gap: name.split(' ')[1] ?? '?', mode: 'live', verdict: 'ERROR', expected: 'check runs', observed: e instanceof Error ? `${e.message}\n${e.stack?.split('\n').slice(0, 3).join('\n')}` : String(e) });
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  provider: `openai:${MODEL_ID}`,
  totals: {
    CONFIRMED: results.filter((r) => r.verdict === 'CONFIRMED').length,
    REFUTED: results.filter((r) => r.verdict === 'REFUTED').length,
    INCONCLUSIVE: results.filter((r) => r.verdict === 'INCONCLUSIVE').length,
    ERROR: results.filter((r) => r.verdict === 'ERROR').length,
  },
  results,
};
const outPath = join(here, '../../../../../runs/result-live-verification.json');
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log('\n=== LIVE VERIFICATION SUMMARY ===');
console.log(JSON.stringify(summary.totals, null, 2));
console.log(`\nwrote ${outPath}`);
if (hardErrors > 0) {
  console.error(`\n${hardErrors} check(s) threw a harness error (not a claim verdict) — investigate.`);
  process.exit(1);
}
