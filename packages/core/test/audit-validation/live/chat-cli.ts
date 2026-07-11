#!/usr/bin/env bun
/**
 * chat-cli — a reusable, scriptable live-API chat driver for real Kuralle agents.
 *
 * Two ways to use it:
 *   1) As a library:   import { runChat, liveModel } from './chat-cli.js'
 *      const obs = await runChat({ agents, defaultAgentId, turns, label });
 *      // obs.transcript, obs.turns[i].{text,toolCalls,toolResults,flowEnters,handoffs,errors}, obs.sessionAt(sid)
 *   2) Standalone demo: `bun test/audit-validation/live/chat-cli.ts`  (runs a bakery agent through 3 turns)
 *
 * Provider: OpenAI gpt-4.1-mini (forced). Needs OPENAI_API_KEY in packages/core/.env or repo .env.
 * It prints a readable trace per turn (User / [flow-enter] / [tool-call] / [handoff] / Assistant) and,
 * with `dumpState: true`, the persisted run state (activeFlow, __completedFlows, runEpoch, messages roles).
 */
import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../../src/runtime/openRun.js';
import type { AgentConfig } from '../../../src/authoring/defineAgent.js';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { reply, defineFlow } from '../../../src/authoring/nodes.js';
import type { HarnessStreamPart, TurnHandle } from '../../../src/types/stream.js';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '../../../.env') });
config({ path: join(here, '../../../../.env') });

export function liveModel(): LanguageModel {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('No OPENAI_API_KEY — live chat cannot run.');
    process.exit(2);
  }
  return createOpenAI({ apiKey: key })(process.env.OPENAI_MODEL ?? 'gpt-4.1-mini');
}

export interface TurnObs {
  user: string;
  text: string;
  toolCalls: string[];
  toolResults: { name: string; result: unknown }[];
  flowEnters: string[];
  flowEnds: string[];
  handoffs: string[];
  nodes: string[];
  errors: string[];
  types: string[];
}

async function driveTurn(user: string, handle: TurnHandle, print: boolean): Promise<TurnObs> {
  const o: TurnObs = { user, text: '', toolCalls: [], toolResults: [], flowEnters: [], flowEnds: [], handoffs: [], nodes: [], errors: [], types: [] };
  try {
    for await (const part of handle.events as AsyncIterable<HarnessStreamPart>) {
      o.types.push(part.type);
      if (part.type === 'text-delta') o.text += part.delta;
      else if (part.type === 'tool-call') { o.toolCalls.push(part.toolName); if (print) console.log(`   [tool-call] ${part.toolName}`); }
      else if (part.type === 'tool-result') o.toolResults.push({ name: part.toolName, result: part.result });
      else if (part.type === 'flow-enter') { o.flowEnters.push(part.flow); if (print) console.log(`   [flow-enter] ${part.flow}`); }
      else if (part.type === 'flow-end') { o.flowEnds.push(part.flow); if (print) console.log(`   [flow-end] ${part.flow}`); }
      else if (part.type === 'handoff') { o.handoffs.push(part.targetAgent); if (print) console.log(`   [handoff → ${part.targetAgent}] ${(part as { reason?: string }).reason ?? ''}`); }
      else if (part.type === 'node-enter') o.nodes.push((part as { nodeName?: string }).nodeName ?? '');
      else if (part.type === 'error') { o.errors.push(String((part as { error?: unknown }).error)); if (print) console.log(`   [error] ${o.errors[o.errors.length - 1]}`); }
    }
    const res = await handle;
    if (!o.text && typeof (res as { text?: string }).text === 'string') o.text = (res as { text: string }).text;
  } catch (e) {
    o.errors.push(e instanceof Error ? e.message : String(e));
    if (print) console.log(`   [threw] ${o.errors[o.errors.length - 1]}`);
  }
  return o;
}

export interface ChatScenario {
  label: string;
  agents: AgentConfig[];
  defaultAgentId: string;
  turns: string[];
  config?: Record<string, unknown>;
  sessionId?: string;
  print?: boolean;
  dumpState?: boolean;
}

export interface ChatObs {
  label: string;
  sessionId: string;
  transcript: string[];
  turns: TurnObs[];
  store: MemoryStore;
  runStateAt: () => Record<string, unknown> | undefined;
}

export async function runChat(scenario: ChatScenario): Promise<ChatObs> {
  const model = liveModel();
  const store = new MemoryStore();
  const runtime = createRuntime({
    agents: scenario.agents,
    defaultAgentId: scenario.defaultAgentId,
    sessionStore: store,
    defaultModel: model,
    ...(scenario.config ?? {}),
  } as Parameters<typeof createRuntime>[0]);
  const sessionId = scenario.sessionId ?? newSessionId();
  const print = scenario.print ?? true;
  const transcript: string[] = [];
  const turns: TurnObs[] = [];

  if (print) console.log(`\n=== ${scenario.label} (openai:${process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'}) ===`);
  for (const input of scenario.turns) {
    if (print) console.log(`\nUser: ${input}`);
    transcript.push(`user: ${input}`);
    const obs = await driveTurn(input, runtime.run({ sessionId, input }), print);
    turns.push(obs);
    transcript.push(`assistant: ${obs.text.trim()}`);
    if (print) console.log(`Assistant: ${obs.text.trim()}`);
    if (scenario.dumpState) {
      const s = await store.get(sessionId);
      const rs = (s as unknown as { durableRuns?: Record<string, { runState?: Record<string, unknown> }> })?.durableRuns?.[sessionId]?.runState;
      if (print) console.log(`   [state] activeFlow=${JSON.stringify(rs?.activeFlow)} runEpoch=${JSON.stringify(rs?.runEpoch)} __completedFlows=${JSON.stringify((rs?.state as Record<string, unknown>)?.__completedFlows)} msgRoles=[${(s?.messages ?? []).map((m) => m.role).join(',')}]`);
    }
  }

  const runStateAt = () => {
    // synchronous best-effort read of the last persisted run state
    return undefined;
  };
  return { label: scenario.label, sessionId, transcript, turns, store, runStateAt };
}

// ── Standalone demo ─────────────────────────────────────────────────────────
if (import.meta.main) {
  const model = liveModel();
  const orderFlow = (() => {
    const ask = reply({ id: 'ask', instructions: 'Confirm the cake order in one sentence and finish.', next: () => ({ end: 'ordered' }) });
    return defineFlow({ name: 'order-cake', description: 'Place a cake order', start: ask, nodes: [ask] });
  })();
  const bakery = defineAgent({
    id: 'bakery',
    instructions: 'You are a friendly bakery assistant. Cakes are 4500 LKR. Use the order-cake flow when the customer wants to order.',
    model,
    flows: [orderFlow],
  });
  await runChat({
    label: 'DEMO: bakery',
    agents: [bakery],
    defaultAgentId: 'bakery',
    turns: ['Hi, how much is a cake?', 'Great, I want to order a chocolate one.', 'yes confirm'],
    dumpState: true,
  });
  console.log('\n(demo complete)');
}
