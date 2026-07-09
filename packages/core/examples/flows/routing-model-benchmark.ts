#!/usr/bin/env node

/**
 * Routing Model Benchmark (v2)
 *
 * Measures latency difference between routing with main model vs fast routing model.
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

const mainModel = openai('gpt-4o');
const miniModel = openai('gpt-4o-mini');
const intakeFlow = createBenchmarkIntakeFlow();

async function runBenchmark(label: string, agent: AgentConfig) {
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: mainModel,
    sessionStore: new MemoryStore(),
  });

  const sessionId = newSessionId();
  const turnTimings: Array<{ input: string; ms: number }> = [];

  for (const input of inputs) {
    const start = Date.now();
    const handle = runtime.run({ sessionId, input });
    for await (const _part of handle.events) {
      /* drain */
    }
    await handle;
    turnTimings.push({ input: input.substring(0, 35), ms: Date.now() - start });
  }

  console.log(`\n${label}`);
  console.log('-'.repeat(65));
  for (const t of turnTimings) {
    const bar = '#'.repeat(Math.round(t.ms / 100));
    console.log(`  ${t.ms.toString().padStart(5)}ms  ${bar}  "${t.input}"`);
  }

  const avg = Math.round(turnTimings.reduce((s, t) => s + t.ms, 0) / turnTimings.length);
  const total = turnTimings.reduce((s, t) => s + t.ms, 0);
  console.log('  -----');
  console.log(`  avg=${avg}ms  total=${total}ms`);
  return { label, turnTimings, avg, total };
}

async function main() {
  console.log('=== Routing Model Benchmark (v2) ===');
  console.log('Main model: gpt-4o  |  Flow: hybrid intake');
  console.log(`Inputs: ${inputs.length} turns (mix of on-flow + detour)\n`);

  const agentA = defineAgent({
    id: 'bench-a',
    instructions: 'You are a helpful receptionist.',
    model: mainModel,
    flows: [intakeFlow],
    routing: { model: mainModel },
  });

  const agentB = defineAgent({
    id: 'bench-b',
    instructions: 'You are a helpful receptionist.',
    model: mainModel,
    flows: [intakeFlow],
    routing: { model: miniModel },
  });

  const resultA = await runBenchmark('A) routing.model = gpt-4o (same as main)', agentA);
  const resultB = await runBenchmark('B) routing.model = gpt-4o-mini (fast)', agentB);

  console.log('\n=== SUMMARY ===');
  const savings = resultA.total - resultB.total;
  const pct = Math.round((savings / resultA.total) * 100);
  console.log(`  A (gpt-4o routing):      total=${resultA.total}ms  avg=${resultA.avg}ms`);
  console.log(`  B (gpt-4o-mini routing): total=${resultB.total}ms  avg=${resultB.avg}ms`);
  console.log(`  Savings: ${savings}ms (${pct}%) across ${inputs.length} turns`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
