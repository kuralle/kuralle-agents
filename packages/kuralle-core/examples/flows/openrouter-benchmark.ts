#!/usr/bin/env node

/**
 * OpenRouter Model Benchmark (v2)
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { openai } from '@ai-sdk/openai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import type { AgentConfig } from '../../src/authoring/defineAgent.js';
import type { LanguageModel } from 'ai';
import { loadExampleEnv } from '../_shared/v2Runner.js';
import { createBenchmarkIntakeFlow } from '../_shared/benchmarkIntakeFlow.js';

loadExampleEnv(import.meta.url);

const openrouterKey = process.env.OPENROUTER_API_KEY;
if (!openrouterKey) {
  console.error('OPENROUTER_API_KEY is required');
  process.exit(1);
}

const openrouter = createOpenRouter({ apiKey: openrouterKey });
const grok41Fast = openrouter('x-ai/grok-4.1-fast');
const grok4Fast = openrouter('x-ai/grok-4-fast');
const gpt4oMini = openai('gpt-4o-mini');
const intakeFlow = createBenchmarkIntakeFlow();

const inputs = [
  'Hi there',
  'My name is Alex Martinez',
  'Wait, what time do you close?',
  'I need to reschedule my appointment',
];

interface TurnResult {
  input: string;
  ms: number;
  response: string;
}

async function runBenchmark(
  label: string,
  agent: AgentConfig,
  defaultModel: LanguageModel,
): Promise<{ label: string; turns: TurnResult[]; avg: number; total: number }> {
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel,
    sessionStore: new MemoryStore(),
  });

  const sessionId = newSessionId();
  const turns: TurnResult[] = [];

  for (const input of inputs) {
    const start = Date.now();
    let response = '';
    try {
      const handle = runtime.run({ sessionId, input });
      for await (const part of handle.events) {
        if (part.type === 'text-delta') response += part.text;
        if (part.type === 'error') response += `[ERROR: ${part.error}]`;
      }
      await handle;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      response = `[EXCEPTION: ${message.substring(0, 80)}]`;
    }
    turns.push({
      input: input.substring(0, 40),
      ms: Date.now() - start,
      response: response.substring(0, 70),
    });
  }

  const total = turns.reduce((s, t) => s + t.ms, 0);
  return { label, turns, avg: Math.round(total / turns.length), total };
}

async function main() {
  console.log('=== OpenRouter + Grok Model Benchmark (v2) ===');
  console.log(`Inputs: ${inputs.length} turns (hybrid intake flow)\n`);

  const configs: Array<{ label: string; agent: AgentConfig; defaultModel: LanguageModel }> = [
    {
      label: 'A) grok-4.1-fast / grok-4.1-fast (hybrid)',
      defaultModel: grok41Fast,
      agent: defineAgent({
        id: 'a',
        instructions: 'You are a helpful receptionist.',
        model: grok41Fast,
        flows: [intakeFlow],
        routing: { model: grok41Fast },
      }),
    },
    {
      label: 'B) grok-4.1-fast / grok-4-fast   (fast routing)',
      defaultModel: grok41Fast,
      agent: defineAgent({
        id: 'b',
        instructions: 'You are a helpful receptionist.',
        model: grok41Fast,
        flows: [intakeFlow],
        routing: { model: grok4Fast },
      }),
    },
    {
      label: 'C) grok-4-fast / grok-4-fast      (all fast)',
      defaultModel: grok4Fast,
      agent: defineAgent({
        id: 'c',
        instructions: 'You are a helpful receptionist.',
        model: grok4Fast,
        flows: [intakeFlow],
        routing: { model: grok4Fast },
      }),
    },
    {
      label: 'D) grok-4-fast strict             (no hybrid)',
      defaultModel: grok4Fast,
      agent: defineAgent({
        id: 'd',
        instructions: 'You are a helpful receptionist.',
        model: grok4Fast,
        flows: [intakeFlow],
      }),
    },
    {
      label: 'E) gpt-4o-mini / gpt-4o-mini      (OpenAI baseline)',
      defaultModel: gpt4oMini,
      agent: defineAgent({
        id: 'e',
        instructions: 'You are a helpful receptionist.',
        model: gpt4oMini,
        flows: [intakeFlow],
        routing: { model: gpt4oMini },
      }),
    },
  ];

  const results = [];
  for (const cfg of configs) {
    const result = await runBenchmark(cfg.label, cfg.agent, cfg.defaultModel);
    results.push(result);
    console.log(`${result.label}`);
    console.log('-'.repeat(80));
    for (const t of result.turns) {
      const bar = '#'.repeat(Math.min(Math.round(t.ms / 100), 40));
      console.log(`  ${t.ms.toString().padStart(5)}ms  ${bar.padEnd(40)}  "${t.input}"`);
    }
    console.log(`  avg=${result.avg}ms  total=${result.total}ms\n`);
  }

  const baseline = results[0]!.total;
  console.log('=== COMPARISON ===\n');
  console.log('  Config                                       avg      total    vs A');
  console.log('  ' + '-'.repeat(74));
  for (const r of results) {
    const savings = baseline - r.total;
    const pct = Math.round((savings / baseline) * 100);
    const delta = savings >= 0 ? `-${savings}ms (${pct}%)` : `+${Math.abs(savings)}ms`;
    console.log(
      `  ${r.label.padEnd(45)}  ${(r.avg + 'ms').padStart(7)}  ${(r.total + 'ms').padStart(8)}  ${delta}`,
    );
  }

  console.log('\n=== DETOUR QUALITY ("Wait, what time do you close?") ===\n');
  for (const r of results) {
    const detour = r.turns.find((t) => t.input.includes('what time'));
    console.log(`  ${r.label.substring(0, 48)}`);
    console.log(`    ${detour?.ms}ms  "${detour?.response}"\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
