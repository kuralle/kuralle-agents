/**
 * CAG Demo CLI — interactive conversation with Bella's assistant.
 */

import dotenv from 'dotenv';
dotenv.config();

import { createRuntime, MemoryStore } from '@kuralle-agents/core';
import { loadPlaygroundEnv, resolvePlaygroundModel } from '../_shared/runtime/model.js';
import { mergeHarnessTools } from '../_shared/runtime/harnessTools.js';
import { buildAgents } from './agent.js';

loadPlaygroundEnv(import.meta.url);
const { model } = resolvePlaygroundModel();
const agents = buildAgents(model);

const runtime = createRuntime({
  agents,
  defaultAgentId: 'bella',
  defaultModel: model,
  sessionStore: new MemoryStore(),
  tools: mergeHarnessTools(agents),
});

let sessionId: string | undefined;

console.log("\nBella's Italian Kitchen (CAG Pattern)");
console.log('Type your questions. Ctrl+C to exit.\n');

const prompt = 'You: ';
process.stdout.write(prompt);

for await (const line of console) {
  if (!line.trim()) { process.stdout.write(prompt); continue; }

  if (!sessionId) sessionId = crypto.randomUUID();
  const handle = runtime.run({ input: line, sessionId });
  for await (const part of handle.events) {
    if (part.type === 'text-delta') process.stdout.write(part.text);
    if (part.type === 'tool-call') {
      console.log(`\n  [CAG search] query="${(part.args as { query?: string })?.query}"`);
    }
    if (part.type === 'tool-result') {
      const chunks = (part.result as { chunks?: unknown[] })?.chunks ?? [];
      console.log(`  [results] ${chunks.length} chunks ranked by LLM`);
    }
  }
  await handle;

  console.log('\n');
  process.stdout.write(prompt);
}
