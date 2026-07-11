/**
 * Demo agent for the TUI chat — a cafe concierge that exercises the fixed behaviours
 * so you can poke at them live: an order flow (collect item+day → place; correct a
 * value mid-collect and the merge overwrites it), a global tool (G8: ask for the
 * special twice, it re-runs), repeatable flows (F9: order again in one session), and
 * a handoff to a billing specialist (G16). Provider: OpenAI gpt-4.1-mini (forced).
 */
import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { reply, collect, defineFlow } from '../../src/authoring/nodes.js';
import { defineTool, buildToolSet } from '../../src/tools/effect/defineTool.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import type { SessionStore } from '../../src/session/SessionStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '../../.env') });
config({ path: join(here, '../../../../.env') });

export function demoModel(): LanguageModel {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('No OPENAI_API_KEY — set it in packages/core/.env or the repo .env');
    process.exit(2);
  }
  return createOpenAI({ apiKey: key })(process.env.OPENAI_MODEL ?? 'gpt-4.1-mini');
}

export interface DemoRuntime {
  runtime: ReturnType<typeof createRuntime>;
  store: SessionStore;
  sessionId: string;
  agentId: string;
  label: string;
  readState: () => Promise<{ activeFlow?: string; runEpoch?: number; completedFlows?: unknown; roles: string[] }>;
}

export function buildDemoRuntime(sessionId = newSessionId(), store: SessionStore = new MemoryStore()): DemoRuntime {
  const model = demoModel();

  // Billing specialist — its own persona + its own tool (exercises the G16 handoff fix).
  const lastInvoice = defineTool({
    name: 'last_invoice',
    description: 'Return the caller last invoice total. Bill uses this to answer billing questions.',
    input: z.object({}),
    execute: async () => ({ invoiceUsd: 18.5, date: '2026-07-01' }),
  });
  const billing = defineAgent({
    id: 'billing',
    instructions: 'You are Bill from billing. Start replies with "Bill here". Use last_invoice for billing questions. Keep replies to one or two sentences.',
    model,
    globalTools: { last_invoice: lastInvoice },
  });

  // Order flow: collect item+day → place. Exercises collect (mid-collect correction
  // overwrites via the merge) and F9 (order again in the same session).
  const done = reply({ id: 'done', instructions: 'Say the order is placed for {{item}} on {{day}} — one upbeat sentence. Do not ask anything else.', next: () => ({ end: 'ordered' }) });
  const collectOrder = collect({
    id: 'collect_order',
    schema: z.object({ item: z.string().min(2).nullable(), day: z.string().min(2).nullable() }),
    required: ['item', 'day'],
    maxTurns: 6,
    instructions: (missing) => `Take the cafe order. Missing: ${missing.join(', ') || 'none'}. Ask for the item and the day; if the caller corrects a value, use the new one.`,
    onComplete: () => done,
  });
  const orderFlow = defineFlow({
    name: 'order',
    description: 'Take a cafe order (item + day) and place it.',
    start: collectOrder,
    nodes: [collectOrder, done],
  });

  // Global tool — available mid-conversation (exercises G8: ask twice, it re-runs).
  const special = defineTool({
    name: 'todays_special',
    description: "Return today's cafe special. Call this whenever the caller asks about the special.",
    input: z.object({}),
    execute: async () => ({ special: 'Cardamom bun', priceUsd: 3.5 }),
  });

  const concierge = defineAgent({
    id: 'concierge',
    instructions:
      'You are a warm cafe concierge. Coffee is $4. Use the order flow when the caller wants to order. ' +
      'Use todays_special for the special. Transfer billing/invoice questions to the billing specialist. Keep replies short.',
    model,
    flows: [orderFlow],
    globalTools: { todays_special: special },
    handoffs: ['billing'],
    agents: [billing],
    experimental: { outOfBandControl: true },
  });

  const runtime = createRuntime({ agents: [concierge, billing], defaultAgentId: 'concierge', sessionStore: store, defaultModel: model });

  const readState = async () => {
    const s = await store.get(sessionId);
    const rs = (s as unknown as { durableRuns?: Record<string, { runState?: { activeFlow?: string; runEpoch?: number; state?: Record<string, unknown> } }> })?.durableRuns?.[sessionId]?.runState;
    return {
      activeFlow: rs?.activeFlow,
      runEpoch: rs?.runEpoch,
      completedFlows: (rs?.state as Record<string, unknown> | undefined)?.__completedFlows,
      roles: (s?.messages ?? []).map((m) => m.role),
    };
  };

  return { runtime, store, sessionId, agentId: 'concierge', label: 'Cafe concierge (order flow · special tool · billing handoff)', readState };
}
