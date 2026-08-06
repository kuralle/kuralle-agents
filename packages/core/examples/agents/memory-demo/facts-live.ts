#!/usr/bin/env bun
/**
 * LIVE end-to-end proof of the extraction pipeline. Real provider, real model
 * calls, real persistence across three separate sessions.
 *
 *     bun packages/core/examples/agents/memory-demo/facts-live.ts
 *
 * Everything in this chain has been verified against mocks. Mocks prove the
 * wiring; they cannot prove a real model returns a value that satisfies the
 * merged schema, or that the merge instructions actually make a contradiction
 * REPLACE a fact rather than sit beside it. That is what this checks.
 *
 * Three sessions, one userId, one store:
 *
 *   1. the user states facts               -> extraction writes them
 *   2. a NEW session asks about them       -> preload injects, agent recalls
 *   3. the user contradicts one            -> merge updates it, old fact GONE
 *
 * Exits non-zero on the first failed assertion, so it is usable as a gate.
 */
import { openai } from '@ai-sdk/openai';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../../src/runtime/openRun.js';
import { InMemoryExtractedValueStore } from '../../../src/memory/extract/InMemoryExtractedValueStore.js';
import { factsExtractor, FACTS_EXTRACTOR_SLUG } from '../../../src/memory/extract/builtin/factsExtractor.js';
import type { StreamPart } from '../../../src/types/stream.js';

const USER_ID = 'live-demo-user';
const model = openai('gpt-4.1-mini');

const extractedValueStore = new InMemoryExtractedValueStore();

const agent = defineAgent({
  id: 'facts-live',
  name: 'Facts Live',
  instructions:
    'You are a concise assistant. When you know something about the user from memory, say it plainly.',
  model,
  memory: {
    preload: { enabled: true, tokenBudget: 500 },
    extract: [factsExtractor()],
    // 'each-turn' so the demo does not have to manufacture 2000 tokens of
    // history to trip the default token trigger.
    extraction: { trigger: 'each-turn', blocking: true },
  },
} as Parameters<typeof defineAgent>[0]);

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: model,
  sessionStore: new MemoryStore(),
  extractedValueStore,
} as Parameters<typeof createRuntime>[0]);

async function turn(label: string, input: string): Promise<string> {
  const handle = runtime.run({ sessionId: newSessionId(), input, userId: USER_ID });
  let text = '';
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') text += (part.payload as { delta: string }).delta;
    if (part.type === 'extraction') {
      const p = part.payload as { slug: string; changed: boolean };
      console.log(`   · extraction: ${p.slug} (changed=${p.changed})`);
    }
  }
  await handle;
  console.log(`${label}\n   > ${input}\n   < ${text.trim()}`);
  return text;
}

async function facts(): Promise<string[]> {
  const row = await extractedValueStore.load('user', USER_ID, FACTS_EXTRACTOR_SLUG);
  return ((row?.value as { facts?: string[] })?.facts ?? []).map((f) => f.toLowerCase());
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

console.log('\n=== 1. state facts ===');
await turn('session 1', 'My name is Mithushan, I live in Colombo, and I am allergic to penicillin.');
const afterOne = await facts();
console.log('   facts:', afterOne);
check('extraction produced facts', afterOne.length > 0, 'store is empty');
check(
  'captured the city',
  afterOne.some((f) => f.includes('colombo')),
  `no fact mentions Colombo: ${JSON.stringify(afterOne)}`,
);
check(
  'captured the allergy',
  afterOne.some((f) => f.includes('penicillin')),
  `no fact mentions penicillin: ${JSON.stringify(afterOne)}`,
);

console.log('\n=== 2. NEW session recalls them ===');
const recall = (await turn('session 2', 'Where do I live?')).toLowerCase();
check('recalled across sessions', recall.includes('colombo'), `reply lacks Colombo: ${recall}`);

console.log('\n=== 3. contradict a fact — merge must REPLACE, not append ===');
await turn('session 3', 'Actually I moved. I live in Kandy now, not Colombo.');
const afterThree = await facts();
console.log('   facts:', afterThree);
check(
  'new city recorded',
  afterThree.some((f) => f.includes('kandy')),
  `no fact mentions Kandy: ${JSON.stringify(afterThree)}`,
);
check(
  'stale city dropped',
  !afterThree.some((f) => f.includes('colombo')),
  `Colombo survived the contradiction — merge appended instead of replacing: ${JSON.stringify(afterThree)}`,
);
check(
  'unrelated fact survived',
  afterThree.some((f) => f.includes('penicillin')),
  `the allergy was lost during the merge: ${JSON.stringify(afterThree)}`,
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
