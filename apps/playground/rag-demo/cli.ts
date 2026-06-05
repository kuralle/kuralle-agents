/**
 * RAG Demo CLI — interactive Acme support agent.
 */

import dotenv from 'dotenv';
dotenv.config();

import { createRuntime, MemoryStore } from '@kuralle-agents/core';
import { loadPlaygroundEnv, resolvePlaygroundModel } from '../_shared/runtime/model.js';
import { mergeHarnessTools } from '../_shared/runtime/harnessTools.js';
import { buildAgents } from './agent.js';
import { ingestKnowledge } from './rag.js';

async function main() {
  loadPlaygroundEnv(import.meta.url);
  await ingestKnowledge();

  const { model } = resolvePlaygroundModel();
  const agents = buildAgents(model);

  const runtime = createRuntime({
    agents,
    defaultAgentId: 'support',
    defaultModel: model,
    sessionStore: new MemoryStore(),
    tools: mergeHarnessTools(agents),
  });

  let sessionId: string | undefined;

  console.log('\nAcme Support Agent (Vector RAG)');
  console.log('Type your questions. Ctrl+C to exit.\n');

  const prompt = 'You: ';
  process.stdout.write(prompt);

  for await (const line of console) {
    if (!line.trim()) { process.stdout.write(prompt); continue; }

  if (!sessionId) sessionId = crypto.randomUUID();
    const handle = runtime.run({ input: line, sessionId });
    for await (const part of handle.events) {
      if (part.type === 'text-delta') process.stdout.write(part.delta);
      if (part.type === 'tool-call') {
        const args = part.args as { query?: string; filter?: unknown };
        console.log(`\n  [search] query="${args?.query}" filter=${JSON.stringify(args?.filter ?? null)}`);
      }
      if (part.type === 'tool-result') {
        const results = (part.result as { results?: { score?: number }[] })?.results ?? [];
        console.log(`  [results] ${results.length} chunks found (top score: ${results[0]?.score?.toFixed(3) ?? 'n/a'})`);
      }
    }
    await handle;

    console.log('\n');
    process.stdout.write(prompt);
  }
}

main().catch(console.error);
