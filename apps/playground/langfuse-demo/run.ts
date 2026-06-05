#!/usr/bin/env bun
/**
 * Langfuse tracing demo with Kuralle v2.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { createRuntime, MemoryStore } from '@kuralle-agents/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { loadPlaygroundEnv, resolvePlaygroundModel } from '../_shared/runtime/model.js';
import { mergeHarnessTools } from '../_shared/runtime/harnessTools.js';
import { buildAgents } from './agents.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
config({ path: join(currentDir, '../../.env') });

if (process.env.LANGFUSE_SECRET_KEY) {
  const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.start();
  console.log('Langfuse telemetry initialized\n');
}

loadPlaygroundEnv(import.meta.url);
const { model } = resolvePlaygroundModel();
const agents = buildAgents(model);

const runtime = createRuntime({
  agents,
  defaultAgentId: 'router',
  defaultModel: model,
  sessionStore: new MemoryStore(),
  tools: mergeHarnessTools(agents),
});

const conversation = [
  'Where is my order? It was supposed to arrive yesterday.',
  'I meant order number 12345.',
  "That's too expensive. Can you check my invoice too?",
  'Can you help me process a return?',
];

async function runDemo() {
  console.log('Kuralle + Langfuse Demo (v2)');
  console.log('='.repeat(65));

  let sessionId: string | undefined;

  for (const input of conversation) {
    console.log(`\nUser: ${input}`);
    process.stdout.write('Assistant: ');

    const handle = runtime.run({ input, sessionId });
    for await (const part of handle.events) {
      if (part.type === 'text-delta') process.stdout.write(part.delta);
      if (part.type === 'tool-call') console.log(`\n[Tool] ${part.toolName}`);
      if (part.type === 'handoff') console.log(`\n[Handoff → ${part.targetAgent}]`);
      if (part.type === 'done') sessionId = part.sessionId;
    }
    await handle;
    console.log('');
  }

  console.log('\nDemo complete.');
}

runDemo().catch(console.error);
