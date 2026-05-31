#!/usr/bin/env node

/**
 * Context Budget Demo — turn limits and message growth (v2)
 *
 * v2 exposes limits via AgentConfig; full token budget telemetry is on the v1 pipeline.
 */

import { openai } from '@ai-sdk/openai';
import readline from 'readline';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { loadExampleEnv } from '../../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

const model = openai('gpt-4o-mini');

const agent = defineAgent({
  id: 'budget-agent',
  name: 'Budget-Aware Agent',
  model,
  instructions: `You are a knowledgeable travel assistant.
You help users plan trips, find flights, book hotels, and discover attractions.
Be concise but thorough. When asked about a destination, provide practical tips.`,
  limits: {
    maxTurns: 50,
    maxSteps: 5,
  },
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: model,
  sessionStore: new MemoryStore(),
  hooks: {
    onEnd: async (ctx) => {
      const messageCount = ctx.runState.messages.length;
      console.log(`\n  [Turn complete] messages in run: ${messageCount}`);
    },
  },
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

async function main() {
  console.log('=== Kuralle Context Budget Demo (v2) ===');
  console.log('Agent limits: maxTurns=50, maxSteps=5');
  console.log('Each turn logs message count after the run completes.');
  console.log('Type "quit" to exit.\n');

  const sessionId = 'budget-demo-session';

  while (true) {
    const input = await ask('You: ');
    if (input.trim() === 'quit') break;

    process.stdout.write('Agent: ');
    const handle = runtime.run({ sessionId, input });
    for await (const part of handle.events) {
      if (part.type === 'text-delta') process.stdout.write(part.text);
    }
    await handle;
    console.log('\n');
  }

  rl.close();
}

main().catch(console.error);
