#!/usr/bin/env node

/**
 * Model Matrix Benchmark (v2)
 */

import { openai } from '@ai-sdk/openai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import type { AgentConfig } from '../../src/authoring/defineAgent.js';
import { loadExampleEnv } from '../_shared/v2Runner.js';
import { createBenchmarkIntakeFlow } from '../_shared/benchmarkIntakeFlow.js';

loadExampleEnv(import.meta.url);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

const inputs = [
  'Hi there',
  'My name is Alex Martinez',
  'Wait, what time do you close?',
  'I need to reschedule my appointment',
];

const gpt4o = openai('gpt-4o');
const gpt4oMini = openai('gpt-4o-mini');

interface TurnResult {
  input: string;
  ms: number;
  response: string;
}

async function runBenchmark(
  label: string,
  agent: AgentConfig,
  defaultModel: typeof gpt4o,
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
    const handle = runtime.run({ sessionId, input });
    for await (const part of handle.events) {
      if (part.type === 'text-delta') response += part.text;
    }
    await handle;
    turns.push({
      input: input.substring(0, 40),
      ms: Date.now() - start,
      response: response.substring(0, 60),
    });
  }

  const total = turns.reduce((s, t) => s + t.ms, 0);
  return { label, turns, avg: Math.round(total / turns.length), total };
}

async function main() {
  console.log('=== Model Matrix Benchmark (v2) ===');
  console.log(`Inputs: ${inputs.length} turns (hybrid intake flow)\n`);

  const intakeFlow = createBenchmarkIntakeFlow();

  const configs: Array<{ label: string; agent: AgentConfig; defaultModel: typeof gpt4o }> = [
    {
      label: 'A) main=gpt-4o      routing=gpt-4o      (baseline)',
      defaultModel: gpt4o,
      agent: defineAgent({
        id: 'a',
        instructions: 'You are a helpful receptionist.',
        model: gpt4o,
        flows: [intakeFlow],
        routing: { model: gpt4o },
      }),
    },
    {
      label: 'B) main=gpt-4o      routing=gpt-4o-mini (fast routing)',
      defaultModel: gpt4o,
      agent: defineAgent({
        id: 'b',
        instructions: 'You are a helpful receptionist.',
        model: gpt4o,
        flows: [intakeFlow],
        routing: { model: gpt4oMini },
      }),
    },
    {
      label: 'C) main=gpt-4o-mini routing=gpt-4o-mini (all mini)',
      defaultModel: gpt4oMini,
      agent: defineAgent({
        id: 'c',
        instructions: 'You are a helpful receptionist.',
        model: gpt4oMini,
        flows: [intakeFlow],
        routing: { model: gpt4oMini },
      }),
    },
    {
      label: 'D) main=gpt-4o-mini intake flow',
      defaultModel: gpt4oMini,
      agent: defineAgent({
        id: 'd',
        instructions: 'You are a helpful receptionist.',
        model: gpt4oMini,
        flows: [intakeFlow],
      }),
    },
  ];

  const results = [];
  for (const cfg of configs) {
    const result = await runBenchmark(cfg.label, cfg.agent, cfg.defaultModel);
    results.push(result);
    console.log(`${result.label}`);
    console.log('-'.repeat(75));
    for (const t of result.turns) {
      const bar = '#'.repeat(Math.min(Math.round(t.ms / 100), 40));
      console.log(`  ${t.ms.toString().padStart(5)}ms  ${bar.padEnd(40)}  "${t.input}"`);
    }
    console.log(`  avg=${result.avg}ms  total=${result.total}ms\n`);
  }

  console.log('=== COMPARISON TABLE ===\n');
  console.log('  Config                                  avg      total    vs baseline');
  console.log('  ' + '-'.repeat(72));
  const baseline = results[0]!.total;
  for (const r of results) {
    const savings = baseline - r.total;
    const pct = Math.round((savings / baseline) * 100);
    const delta = savings >= 0 ? `-${savings}ms (${pct}%)` : `+${Math.abs(savings)}ms`;
    console.log(
      `  ${r.label.substring(0, 40).padEnd(40)}  ${(r.avg + 'ms').padStart(7)}  ${(r.total + 'ms').padStart(8)}  ${delta}`,
    );
  }

  console.log('\n=== RESPONSE QUALITY SPOT-CHECK ===');
  console.log('(Detour turn: "Wait, what time do you close?")\n');
  for (const r of results) {
    const detourTurn = r.turns.find((t) => t.input.includes('what time'));
    console.log(`  ${r.label.substring(0, 45)}`);
    console.log(`    "${detourTurn?.response}..."\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
