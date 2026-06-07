#!/usr/bin/env node
/**
 * Kuralle sink spike (v2) — durable event surfaces into local JSONL files.
 */

import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, appendFile } from 'node:fs/promises';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { collect, defineFlow, reply } from '../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import type { Hooks } from '../../src/types/hooks.js';
import { loadExampleEnv } from '../_shared/v2Runner.js';

const here = dirname(fileURLToPath(import.meta.url));
loadExampleEnv(import.meta.url);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

const outDir = resolve(here, 'out');
const streamPath = join(outDir, 'stream.jsonl');
const hooksPath = join(outDir, 'hooks.jsonl');

await mkdir(outDir, { recursive: true });

async function logHook(name: string, payload: unknown) {
  await appendFile(
    hooksPath,
    JSON.stringify({ ts: new Date().toISOString(), event: name, payload }) + '\n',
    'utf8',
  );
}

async function logStream(part: HarnessStreamPart) {
  await appendFile(
    streamPath,
    JSON.stringify({ ts: new Date().toISOString(), part }) + '\n',
    'utf8',
  );
}

const hooks: Hooks = {
  onStart: async (ctx) => logHook('onStart', { sessionId: ctx.session.id, agentId: ctx.runState.activeAgentId }),
  onEnd: async (ctx) => logHook('onEnd', { sessionId: ctx.session.id }),
  onStreamPart: async (ctx, part) => {
    await logStream(part);
    if (part.type === 'tool-call') {
      await logHook('onToolCall', {
        sessionId: ctx.session.id,
        toolName: part.toolName,
        args: part.args,
      });
    }
    if (part.type === 'tool-result') {
      await logHook('onToolResult', {
        sessionId: ctx.session.id,
        toolName: part.toolName,
        output: part.result,
      });
    }
    if (part.type === 'error') {
      await logHook('onError', { sessionId: ctx.session.id, error: part.error });
    }
    if (part.type === 'handoff') {
      await logHook('onHandoff', {
        sessionId: ctx.session.id,
        to: part.targetAgent,
        reason: part.reason,
      });
    }
  },
};

const bookingSchema = z.object({
  customerName: z.string().nullable(),
  appointmentDate: z.string().nullable(),
});

const model = openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');

const book = reply({
  id: 'book',
  instructions:
    'Confirm the appointment and call book_appointment with customerName and appointmentDate from state. Then end politely.',
  model,
  tools: buildToolSet({
    book_appointment: defineTool({
      name: 'book_appointment',
      description: 'Book the confirmed appointment.',
      input: z.object({
        customerName: z.string(),
        appointmentDate: z.string(),
      }),
      execute: async ({ customerName, appointmentDate }) => ({
        bookingId: 'BK-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        customerName,
        appointmentDate,
        confirmed: true,
      }),
    }),
  }),
  next: (turn) => {
    if (turn.toolResults.some((r) => r.name === 'book_appointment')) return { end: 'booked' };
    return 'stay';
  },
});

const greet = collect({
  id: 'greet',
  schema: bookingSchema,
  required: ['customerName', 'appointmentDate'],
  maxTurns: 8,
  instructions: (missing, state) =>
    `Booking agent for a service business. Collect name and appointment date. Missing: ${missing.join(', ') || 'none'}. ` +
    `You may call lookup_customer by name. When both fields are collected, proceed to booking.`,
  onComplete: () => book,
});

const agent = defineAgent({
  id: 'kuralle-sink-spike',
  name: 'Kuralle Sink Spike',
  instructions:
    "You are a booking agent. Use very simple language. Avoid emojis. Don't repeat yourself.",
  model,
  tools: {
    lookup_customer: defineTool({
      name: 'lookup_customer',
      description: 'Looks up an existing customer by name.',
      input: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        if (name.toLowerCase().includes('error')) {
          throw new Error('Customer database temporarily unavailable');
        }
        return { onFile: name.toLowerCase() === 'sarah', loyaltyTier: 'gold' };
      },
    }),
  },
  flows: [
    defineFlow({
      name: 'booking',
      description: 'Book a service appointment',
      start: greet,
      nodes: [greet, book],
    }),
  ],
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: model,
  sessionStore: new MemoryStore(),
  hooks,
});

const prompts = [
  "Hi, I'd like to book an appointment.",
  'My name is Sarah.',
  'Next Tuesday at 10am.',
];

const sessionId = newSessionId();
console.log('--- Kuralle sink spike (v2) ---');

for (const input of prompts) {
  console.log('\nUser: ' + input);
  let response = '';
  const handle = runtime.run({ sessionId, input });
  for await (const part of handle.events) {
    if (part.type === 'text-delta') response += part.delta;
  }
  await handle;
  console.log('Assistant: ' + response.trim());
}

console.log('\nDone. Logs at:');
console.log('  ' + streamPath);
console.log('  ' + hooksPath);
