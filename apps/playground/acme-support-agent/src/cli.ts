/**
 * Acme Corp Support Agent — Interactive CLI
 *
 * Prerequisites: Run `bun run ingest` first.
 */

import { config } from 'dotenv';
config();

import * as readline from 'readline';
import { createRuntime, MemoryStore } from '@kuralle-agents/core';
import { loadPlaygroundEnv, resolvePlaygroundModel } from '../../_shared/runtime/model.js';
import { mergeHarnessTools } from '../../_shared/runtime/harnessTools.js';
import { buildAgents } from './agents.js';
import { knowledgeConfig } from './knowledge.js';

loadPlaygroundEnv(import.meta.url);
const { model } = resolvePlaygroundModel();
const agents = buildAgents(model);

const runtime = createRuntime({
  agents,
  defaultAgentId: 'triage',
  defaultModel: model,
  sessionStore: new MemoryStore(),
  knowledge: knowledgeConfig,
  tools: mergeHarnessTools(agents),
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let sessionId: string | undefined;

console.log('\nAcme Corp Support Agent — type "quit" to exit.\n');

function prompt() {
  rl.question('You: ', async (input) => {
    if (!input || input.trim() === 'quit') {
      rl.close();
      process.exit(0);
    }

    process.stdout.write('\nAgent: ');
    try {
      const handle = runtime.run({ sessionId, input: input.trim() });
      let nextSessionId = sessionId;
      for await (const event of handle.events) {
        if (event.type === 'text-delta') process.stdout.write(event.delta);
        if (event.type === 'handoff') console.log(`\n  → Routed to ${event.targetAgent}`);
        if (event.type === 'done') nextSessionId = event.sessionId;
      }
      await handle;
      sessionId = nextSessionId;
      console.log('\n');
    } catch (error) {
      console.error('\nError:', error instanceof Error ? error.message : String(error));
    }
    prompt();
  });
}

prompt();
