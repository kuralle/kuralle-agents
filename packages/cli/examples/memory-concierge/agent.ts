/**
 * Memory concierge — a CLI agent exercising everything shipped in the
 * extraction chain, end to end, across separate processes.
 *
 *   kuralle send --agent packages/cli/examples/memory-concierge/agent.ts \
 *     "I'm Mithushan, I run a bakery in Colombo and I'm allergic to penicillin."
 *
 *   kuralle send --agent packages/cli/examples/memory-concierge/agent.ts \
 *     "What do you know about me?"
 *
 * The second command is a NEW process with a NEW session. It recalls the first
 * because facts were extracted into a FileExtractedValueStore on disk — which
 * is the point: an in-memory store would make this demo pass inside one process
 * and fail the moment it matters.
 *
 * `dietaryProfile` below is the extractor `preload` never reads (preload only
 * ever loads the `facts` slug) — a THIRD command shows the model reaching for
 * it explicitly through `search_memory`, the only path that value has:
 *
 *   kuralle send --agent packages/cli/examples/memory-concierge/agent.ts \
 *     --user mithushan --session s3 "Am I allergic to anything?"
 *
 * What it demonstrates, all from this chain:
 *
 *   memory.extract           two extractors, one merged model call
 *   factsExtractor()         the built-in, replacing the old ingest service
 *   onExtracted              an interceptor that shapes a value before storage
 *   FileExtractedValueStore  durable across processes
 *   memory.preload           the automatic read half — prior facts into the prompt
 *   search_memory            the explicit read half — a model-initiated query
 *                            over every declared extractor, `facts` included
 *   workingMemory.autoLoad   declares the blocks `memory_block` may address
 *   parallelSafe predicate   one tool, parallel for reads and serial for writes
 *   maxToolResultTokens      the transcript-boundary cap
 */
import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import {
  createRuntime,
  defineAgent,
  defineTool,
  defineExtractor,
  factsExtractor,
  FileExtractedValueStore,
  FilePersistentMemoryStore,
  MemoryStore,
} from '@kuralle-agents/core';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '../../../../.env') });

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = openai('gpt-4.1-mini');

/** Durable across CLI invocations — the whole point of the two-command demo. */
const extractedValueStore = new FileExtractedValueStore({
  rootDir: join(here, '.memory/extracted'),
});

/**
 * A second, typed extractor alongside facts. Both slugs go into ONE merged
 * structured call, not two — and `onExtracted` normalises before persistence
 * rather than hoping the model formats consistently.
 */
const dietaryProfile = defineExtractor({
  name: 'Dietary Profile',
  scope: 'user',
  instructions:
    'Allergies and dietary restrictions this person has stated. Only what they said about themselves.',
  schema: z.object({
    allergies: z.array(z.string()),
    avoids: z.array(z.string()),
  }),
  onExtracted: ({ current }) => ({
    allergies: [...new Set(current.allergies.map((a) => a.toLowerCase().trim()))].sort(),
    avoids: [...new Set(current.avoids.map((a) => a.toLowerCase().trim()))].sort(),
  }),
});

const ORDERS: Record<string, { item: string; status: string }> = {
  'A-1': { item: 'sourdough x2', status: 'ready for collection' },
  'A-2': { item: 'birthday cake', status: 'baking' },
};

/**
 * One tool, two modes. `parallelSafe` is a PREDICATE over the args, so a `read`
 * batches with its siblings while a `write` becomes a serial barrier — the
 * distinction a static boolean could not express.
 */
const orders = defineTool({
  name: 'orders',
  description: "Look up an order, or update an order's status.",
  input: z.object({
    mode: z.enum(['read', 'write']),
    id: z.string(),
    status: z.string().optional(),
  }),
  parallelSafe: (args) => (args as { mode?: string })?.mode === 'read',
  execute: async ({ mode, id, status }) => {
    if (mode === 'read') return ORDERS[id] ?? { error: 'no such order' };
    if (!ORDERS[id]) return { error: 'no such order' };
    ORDERS[id]!.status = status ?? ORDERS[id]!.status;
    return { id, updated: true, status: ORDERS[id]!.status };
  },
});

const agent = defineAgent({
  id: 'memory-concierge',
  name: 'Memory Concierge',
  instructions: [
    'You are the concierge for a small bakery.',
    'When memory tells you something about this customer, use it without asking again.',
    'Keep replies to one or two sentences.',
  ].join(' '),
  model,
  tools: { orders },
  memory: {
    preload: { enabled: true, tokenBudget: 400 },
    extract: [factsExtractor(), dietaryProfile],
    // 'each-turn' keeps the demo legible; the shipped default is
    // { tokens: 2000 } so an ordinary turn costs nothing.
    extraction: { trigger: 'each-turn', blocking: true },
    workingMemory: {
      store: new FilePersistentMemoryStore({ rootDir: join(here, '.memory/blocks') }),
      // `memory_block` is an enum over exactly these — the model cannot name
      // anything else, and extracted values are not in this namespace at all.
      autoLoad: [
        { scope: 'user', key: 'USER' },
        { scope: 'agent', key: 'MEMORY' },
      ],
    },
  },
  limits: { maxToolResultTokens: 4000, maxToolConcurrency: 8 },
} as Parameters<typeof defineAgent>[0]);

export const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: model,
  sessionStore: new MemoryStore(),
  extractedValueStore,
} as Parameters<typeof createRuntime>[0]);

export default runtime;
