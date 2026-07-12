/**
 * Demo agent for the CLI — a cafe concierge that exercises fixed behaviours:
 * order flow (collect item+day → place), global tool (todays_special), repeatable
 * flows, and billing handoff. Provider: OpenAI gpt-4.1-mini (forced).
 */
import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import {
  createRuntime,
  defineAgent,
  defineFlow,
  reply,
  collect,
  defineTool,
  MemoryStore,
  MemoryTraceStore,
  type SessionStore,
  type TraceStore,
} from '@kuralle-agents/core';
import type { AgentRuntime, BuildRuntime } from './agentRuntime.js';
import { newSessionId } from './sessionId.js';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '../.env') });
config({ path: join(here, '../../../.env') });

export function demoModel(): LanguageModel {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('No OPENAI_API_KEY — set it in packages/cli/.env or the repo .env');
    process.exit(2);
  }
  return createOpenAI({ apiKey: key })(process.env.OPENAI_MODEL ?? 'gpt-4.1-mini');
}

export function buildDemoRuntime(
  sessionId = newSessionId(),
  store: SessionStore = new MemoryStore(),
  traceStore: TraceStore = new MemoryTraceStore(),
): AgentRuntime {
  const model = demoModel();

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

  const done = reply({
    id: 'done',
    instructions: 'Say the order is placed for {{item}} on {{day}} — one upbeat sentence. Do not ask anything else.',
    next: () => ({ end: 'ordered' }),
  });
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

  const runtime = createRuntime({
    agents: [concierge, billing],
    defaultAgentId: 'concierge',
    sessionStore: store,
    defaultModel: model,
    tracing: { store: traceStore },
  });

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

  return {
    runtime,
    store,
    sessionId,
    agentId: 'concierge',
    label: 'Cafe concierge (order flow · special tool · billing handoff)',
    readState,
  };
}

/** Alias matching the custom-agent contract (`buildRuntime`). */
export const buildRuntime: BuildRuntime = buildDemoRuntime;