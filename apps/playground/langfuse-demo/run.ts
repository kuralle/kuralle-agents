#!/usr/bin/env bun
/**
 * Langfuse tracing demo with Kuralle v2.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { trace } from '@opentelemetry/api';
import { createRuntime, MemoryStore, registerAiSdkOpenTelemetry } from '@kuralle-agents/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { loadPlaygroundEnv, resolvePlaygroundModel } from '../_shared/runtime/model.js';
import { mergeHarnessTools } from '../_shared/runtime/harnessTools.js';
import { buildAgents } from './agents.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
config({ path: join(currentDir, '../../.env') });

loadPlaygroundEnv(import.meta.url);

if (process.env.LANGFUSE_SECRET_KEY) {
  const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.start();
  registerAiSdkOpenTelemetry({ tracer: trace.getTracer('kuralle-langfuse-demo') });
  console.log('Langfuse telemetry initialized\n');

  process.on('beforeExit', () => {
    void sdk.shutdown();
  });
}

const { model } = resolvePlaygroundModel();

const agents = buildAgents(model);

const runtime = createRuntime({
  agents,
  defaultAgentId: 'router',
  defaultModel: model,
  sessionStore: new MemoryStore(),
  tools: mergeHarnessTools(agents),
  aiSdkTelemetry: process.env.LANGFUSE_SECRET_KEY ? { enabled: true } : undefined,
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
      if (part.type === 'text-delta') process.stdout.write(part.payload.delta);
      if (part.type === 'tool-call') console.log(`\n[Tool] ${part.payload.toolName}`);
      if (part.type === 'handoff') console.log(`\n[Handoff → ${part.payload.targetAgent}]`);
      if (part.type === 'done') sessionId = part.payload.sessionId;
    }
    await handle;
    console.log('');
  }

  if (process.env.LANGFUSE_SECRET_KEY) {
    console.log('\nLangfuse spans flushed.');
  }

  console.log('\nDemo complete.');
}

runDemo().catch(console.error);
