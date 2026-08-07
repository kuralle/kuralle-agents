#!/usr/bin/env bun
/**
 * RED GATE for `search_memory`.
 *
 * The gap is sharper than "you cannot query memory". `defineExtractor` is a
 * shipped, documented public API — and anything defined with it is WRITE-ONLY.
 *
 *   preloadMemory.ts:52   store.load('user', userId, FACTS_EXTRACTOR_SLUG)
 *
 * That is the only production read that serves the agent. The one other read,
 * runExtractors.ts:146, loads a slug's prior value to feed back into the merge —
 * it never reaches the prompt. So a custom extractor's value is persisted every
 * turn and then read by nothing, forever.
 *
 * This script proves it live: a `dietaryProfile` extractor records an allergy,
 * the row is verified on disk, and then a NEW session is asked about it. The
 * agent cannot answer, because nothing can reach the row.
 *
 * Expected BEFORE the fix: 1 of 2 checks fail.
 * Expected AFTER:          both pass — via the search_memory tool.
 */
import { openai } from '@ai-sdk/openai';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { defineExtractor } from '../../../src/memory/extract/defineExtractor.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../../src/runtime/openRun.js';
import { FileExtractedValueStore } from '../../../src/memory/extract/FileExtractedValueStore.js';
import { factsExtractor } from '../../../src/memory/extract/builtin/factsExtractor.js';
import type { StreamPart } from '../../../src/types/stream.js';

const USER = 'redgate-user';
const model = openai('gpt-4.1-mini');
const store = new FileExtractedValueStore({ rootDir: mkdtempSync(join(tmpdir(), 'searchgate-')) });

const dietaryProfile = defineExtractor({
  name: 'Dietary Profile',
  scope: 'user',
  instructions: 'Allergies and dietary restrictions this person stated about themselves.',
  schema: z.object({
    allergies: z.array(z.string()),
    avoids: z.array(z.string()),
  }),
});

const agent = defineAgent({
  id: 'concierge',
  name: 'Concierge',
  instructions:
    'You are a bakery concierge. Answer from what you know about the customer. If you do not know, say so plainly — never guess.',
  model,
  memory: {
    preload: { enabled: true, tokenBudget: 400 },
    extract: [factsExtractor(), dietaryProfile],
    extraction: { trigger: 'each-turn', blocking: true },
  },
} as Parameters<typeof defineAgent>[0]);

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: model,
  sessionStore: new MemoryStore(),
  extractedValueStore: store,
} as Parameters<typeof createRuntime>[0]);

async function turn(input: string): Promise<{ text: string; toolsCalled: string[] }> {
  const handle = runtime.run({ sessionId: newSessionId(), input, userId: USER });
  let text = '';
  const toolsCalled: string[] = [];
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') text += (part.payload as { delta: string }).delta;
    if (part.type === 'tool-call') {
      const name = (part.payload as { name?: string; toolName?: string })?.name
        ?? (part.payload as { toolName?: string })?.toolName;
      if (name) toolsCalled.push(name);
    }
  }
  await handle;
  return { text: text.trim(), toolsCalled };
}

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) failures += 1;
};

console.log('\n=== 1. state something only the custom extractor captures ===');
await turn('I have a severe shellfish allergy, please note it.');
console.log('  > (sent)');

const row = await store.load('user', USER, dietaryProfile.slug);
const allergies = ((row?.value as { allergies?: string[] })?.allergies ?? []).map((a) => a.toLowerCase());
console.log(`  on disk (${dietaryProfile.slug}):`, JSON.stringify(allergies));
check(
  'the custom extractor persisted the allergy',
  allergies.some((a) => a.includes('shellfish')),
  `nothing stored under slug "${dietaryProfile.slug}": ${JSON.stringify(row?.value)}`,
);

console.log('\n=== 2. a NEW session asks about it ===');
const asked = await turn('Am I allergic to anything?');
const reply = asked.text.toLowerCase();
console.log('  tools called:', JSON.stringify(asked.toolsCalled));
console.log('  <', reply);
check(
  'the agent can reach the custom extractor value',
  reply.includes('shellfish'),
  `stored on disk but unreachable — preloadMemory reads only the facts slug, and nothing else reads the store: ${reply}`,
);
// The answer alone is not proof. Widening preload to load every slug would also
// produce it, and that is the shortcut this tool exists to avoid — it would put
// every extractor's full value in every prompt. Assert the ROUTE, not just the
// result.
check(
  'and it got there by calling search_memory, not by preload being widened',
  asked.toolsCalled.includes('search_memory'),
  `answered without calling the tool; tools called: ${JSON.stringify(asked.toolsCalled)}`,
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
