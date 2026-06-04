/**
 * Gemini reasoning test — key agent types with thinking on vs off (v2)
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { google } from '@ai-sdk/google';
import type { GoogleLanguageModelOptions } from '@ai-sdk/google';
import { z } from 'zod';
import { defineAgent } from '../src/authoring/defineAgent.js';
import { collect, defineFlow, reply } from '../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../src/tools/effect/defineTool.js';
import { createRuntime } from '../src/runtime/Runtime.js';
import { MemoryStore } from '../src/session/stores/MemoryStore.js';
import { newSessionId } from '../src/runtime/openRun.js';
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(currentDir, '../../..');
try {
  const envFile = readFileSync(join(rootDir, '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {
  /* optional */
}

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  console.log('SKIP: Set GOOGLE_GENERATIVE_AI_API_KEY');
  process.exit(0);
}

const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function makeModel(level: ThinkingLevel): LanguageModel {
  const base = google(MODEL_NAME);
  if (level === 'off') return base;
  return wrapLanguageModel({
    model: base,
    middleware: defaultSettingsMiddleware({
      settings: {
        providerOptions: {
          google: {
            thinkingConfig: { thinkingLevel: level, includeThoughts: true },
          } satisfies GoogleLanguageModelOptions,
        },
      },
    }),
  });
}

type ScenarioResult = {
  name: string;
  reasoning: boolean;
  success: boolean;
  ttftMs: number;
  totalMs: number;
  toolsCalled: string[];
  handoffs: string[];
  responsePreview: string;
  error?: string;
};

async function runStream(
  runtime: ReturnType<typeof createRuntime>,
  input: string,
  sessionId: string,
) {
  const start = performance.now();
  let ttft = 0;
  let text = '';
  const tools: string[] = [];
  const handoffs: string[] = [];

  const handle = runtime.run({ sessionId, input });
  for await (const part of handle.events) {
    if (part.type === 'text-delta') {
      if (!ttft) ttft = Math.round(performance.now() - start);
      text += part.delta;
    } else if (part.type === 'tool-result') {
      tools.push(part.toolName);
    } else if (part.type === 'handoff') {
      handoffs.push(part.targetAgent);
    }
  }
  await handle;

  return {
    text,
    tools,
    handoffs,
    ttftMs: ttft || Math.round(performance.now() - start),
    totalMs: Math.round(performance.now() - start),
  };
}

async function singleAgentScenario(model: LanguageModel, reasoning: boolean): Promise<ScenarioResult> {
  const agent = defineAgent({
    id: 'assistant',
    name: 'Weather Bot',
    model,
    instructions:
      'You are a weather assistant. Use check_weather for weather questions. Keep responses to 1 sentence.',
    tools: buildToolSet({
      check_weather: defineTool({
        name: 'check_weather',
        description: 'Check weather for a city',
        input: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, temp: 22, condition: 'partly cloudy' }),
      }),
    }),
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: model,
    sessionStore: new MemoryStore(),
  });

  try {
    const result = await runStream(runtime, 'What is the weather in Tokyo?', `single-${reasoning}`);
    return {
      name: 'Single agent + tools',
      reasoning,
      success: result.tools.includes('check_weather') && result.text.length > 0,
      ttftMs: result.ttftMs,
      totalMs: result.totalMs,
      toolsCalled: result.tools,
      handoffs: result.handoffs,
      responsePreview: result.text.slice(0, 100),
    };
  } catch (err) {
    return {
      name: 'Single agent + tools',
      reasoning,
      success: false,
      ttftMs: 0,
      totalMs: 0,
      toolsCalled: [],
      handoffs: [],
      responsePreview: '',
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

async function flowAgentScenario(model: LanguageModel, reasoning: boolean): Promise<ScenarioResult> {
  const confirm = reply({
    id: 'confirm',
    instructions: 'Confirm the reservation is booked.',
    model,
    next: () => ({ end: 'booked' }),
  });

  const bookingSchema = z.object({
    partySize: z.number().nullable(),
    date: z.string().nullable(),
  });

  const greeting = collect({
    id: 'greeting',
    schema: bookingSchema,
    required: ['partySize', 'date'],
    instructions: () => 'Greet the customer and collect party size and date for a reservation.',
    onComplete: () => confirm,
  });

  const agent = defineAgent({
    id: 'restaurant',
    name: 'Restaurant Bot',
    model,
    instructions: 'You are a restaurant reservation assistant. Follow the flow.',
    flows: [
      defineFlow({
        name: 'booking',
        description: 'Restaurant reservation',
        start: greeting,
        nodes: [greeting, confirm],
      }),
    ],
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: model,
    sessionStore: new MemoryStore(),
  });

  try {
    const sid = newSessionId();
    const t1 = await runStream(
      runtime,
      'Hi, I want to book a table for 4 people this Saturday',
      sid,
    );
    return {
      name: 'Flow agent + collect',
      reasoning,
      success: t1.text.length > 0,
      ttftMs: t1.ttftMs,
      totalMs: t1.totalMs,
      toolsCalled: t1.tools,
      handoffs: t1.handoffs,
      responsePreview: t1.text.slice(0, 100),
    };
  } catch (err) {
    return {
      name: 'Flow agent + collect',
      reasoning,
      success: false,
      ttftMs: 0,
      totalMs: 0,
      toolsCalled: [],
      handoffs: [],
      responsePreview: '',
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

async function triageScenario(model: LanguageModel, reasoning: boolean): Promise<ScenarioResult> {
  const tracking = defineAgent({
    id: 'tracking',
    name: 'Tracking',
    model,
    instructions: 'Help track orders. Use lookup_order. Keep responses short.',
    tools: buildToolSet({
      lookup_order: defineTool({
        name: 'lookup_order',
        description: 'Look up order status',
        input: z.object({ orderNumber: z.string() }),
        execute: async ({ orderNumber }) => ({ orderNumber, status: 'shipped', eta: 'Tomorrow' }),
      }),
    }),
  });

  const billing = defineAgent({
    id: 'billing',
    name: 'Billing',
    model,
    instructions: 'Help with billing. Keep responses short.',
  });

  const hub = defineAgent({
    id: 'hub',
    name: 'Hub',
    model,
    instructions: 'Route to tracking for order questions, billing for payment questions.',
    routes: [
      { agent: 'tracking', when: 'order tracking or shipment status' },
      { agent: 'billing', when: 'billing or payment questions' },
    ],
    routing: { mode: 'structured', always: true },
    agents: [tracking, billing],
  });

  const runtime = createRuntime({
    agents: [hub, tracking, billing],
    defaultAgentId: 'hub',
    defaultModel: model,
    sessionStore: new MemoryStore(),
  });

  try {
    const sid = newSessionId();
    const t1 = await runStream(runtime, 'I need to track order ORD-5001', sid);
    return {
      name: 'Triage agent + handoff',
      reasoning,
      success: t1.handoffs.length > 0 || t1.tools.length > 0,
      ttftMs: t1.ttftMs,
      totalMs: t1.totalMs,
      toolsCalled: t1.tools,
      handoffs: t1.handoffs,
      responsePreview: t1.text.slice(0, 100),
    };
  } catch (err) {
    return {
      name: 'Triage agent + handoff',
      reasoning,
      success: false,
      ttftMs: 0,
      totalMs: 0,
      toolsCalled: [],
      handoffs: [],
      responsePreview: '',
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

async function main() {
  const levels = (process.env.THINKING_LEVELS?.split(',') as ThinkingLevel[]) || [...THINKING_LEVELS];

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Gemini Reasoning Test (v2) — ${MODEL_NAME}`);
  console.log(`  Levels: ${levels.join(', ')}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results: (ScenarioResult & { level: string })[] = [];
  const scenarios = [
    { fn: singleAgentScenario, label: 'Single agent + tools' },
    { fn: flowAgentScenario, label: 'Flow agent + collect' },
    { fn: triageScenario, label: 'Triage + handoff' },
  ];

  for (const { fn, label } of scenarios) {
    console.log(`── ${label} ──`);
    for (const level of levels) {
      const model = makeModel(level);
      console.log(`  [${level}]`);
      const r = await fn(model, level !== 'off');
      results.push({ ...r, level });
      console.log(
        `    ${r.success ? '✓' : '✗'} ttft=${r.ttftMs}ms total=${r.totalMs}ms tools=[${r.toolsCalled}] handoffs=[${r.handoffs}]`,
      );
      if (r.error) console.log(`    ERROR: ${r.error}`);
    }
    console.log();
  }

  const passCount = results.filter((r) => r.success).length;
  console.log(`  ${passCount}/${results.length} passed. ${passCount === results.length ? 'ALL PASS' : 'SOME FAILED'}`);
  process.exit(passCount === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
