#!/usr/bin/env bun
/**
 * LIVE multi-tenant proof of the memory-store owner-key fix.
 *
 *     bun packages/core/examples/agents/memory-demo/owner-isolation-live.ts
 *
 * The use case: one bakery concierge, four customers arriving through different
 * identity providers, each with a userId shaped the way real providers shape
 * them. Every one of these ids either collided or was silently orphaned before
 * this fix.
 *
 *   maya@example.com     an email — Auth0 database connections, Firebase
 *   google-oauth2|123    a pipe — Auth0 social connections
 *   tenant:acme          a colon — the shape that COLLIDED in Redis and InMemory
 *   alice/bob            a slash — malformed; must be refused, not sanitised
 *
 * Unit tests prove the key derivation. They cannot prove that a real model,
 * a real store on a real filesystem and a real runtime keep four customers
 * apart across sessions — which is the property a customer actually cares
 * about, and the one an earlier live run showed 1067 green mock tests can miss.
 *
 * Exits non-zero on the first failed assertion, so it is usable as a gate.
 */
import { openai } from '@ai-sdk/openai';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../../src/runtime/openRun.js';
import { FilePersistentMemoryStore } from '../../../src/memory/blocks/FilePersistentMemoryStore.js';
import { encodeFileSegment } from '../../../src/memory/blocks/ownerKey.js';
import { FileExtractedValueStore } from '../../../src/memory/extract/FileExtractedValueStore.js';
import { factsExtractor, FACTS_EXTRACTOR_SLUG } from '../../../src/memory/extract/builtin/factsExtractor.js';
import type { StreamPart } from '../../../src/types/stream.js';

const model = openai('gpt-4.1-mini');
const root = mkdtempSync(join(tmpdir(), 'kuralle-owner-live-'));
const blockStore = new FilePersistentMemoryStore({ rootDir: join(root, 'blocks') });
const extractedValueStore = new FileExtractedValueStore({ rootDir: join(root, 'extracted') });

const agent = defineAgent({
  id: 'bakery-concierge',
  name: 'Bakery Concierge',
  instructions: [
    'You are the concierge for a small bakery.',
    'When memory tells you something about this customer, use it without asking again.',
    'If you do not know something about the customer, say so plainly. Never guess a name or an order.',
    'Keep replies to one short sentence.',
  ].join(' '),
  model,
  memory: {
    preload: { enabled: true, tokenBudget: 400 },
    extract: [factsExtractor()],
    extraction: { trigger: 'each-turn', blocking: true },
    workingMemory: {
      store: blockStore,
      autoLoad: [{ scope: 'user', key: 'USER' }],
    },
  },
} as Parameters<typeof defineAgent>[0]);

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: model,
  sessionStore: new MemoryStore(),
  extractedValueStore,
} as Parameters<typeof createRuntime>[0]);

async function turn(userId: string, input: string): Promise<string> {
  const handle = runtime.run({ sessionId: newSessionId(), input, userId });
  let text = '';
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') text += (part.payload as { delta: string }).delta;
  }
  await handle;
  return text.trim();
}

async function factsFor(userId: string): Promise<string[]> {
  const row = await extractedValueStore.load('user', userId, FACTS_EXTRACTOR_SLUG);
  return ((row?.value as { facts?: string[] })?.facts ?? []).map((f) => f.toLowerCase());
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  if (!ok) failures += 1;
}

// The three legal ids. Each states a distinct, unmistakable fact.
const CUSTOMERS = [
  { id: 'maya@example.com', name: 'Maya', item: 'sourdough', shape: 'email' },
  { id: 'google-oauth2|123', name: 'Dilan', item: 'croissants', shape: 'pipe' },
  { id: 'tenant:acme', name: 'Priya', item: 'birthday cake', shape: 'colon' },
];

console.log(`\nstore: ${root}\n`);
console.log('=== 1. three customers, three identity shapes, one session each ===');
for (const c of CUSTOMERS) {
  const reply = await turn(c.id, `Hi, I'm ${c.name}. My usual order is ${c.item}.`);
  console.log(`  [${c.shape.padEnd(5)}] ${c.id}\n     < ${reply}`);
}

console.log('\n=== 2. each returns in a NEW session and must be recognised ===');
for (const c of CUSTOMERS) {
  const reply = (await turn(c.id, 'What is my usual order?')).toLowerCase();
  console.log(`  [${c.shape.padEnd(5)}] ${c.id}\n     < ${reply}`);
  check(
    `${c.shape}-shaped id recalls its own order`,
    reply.includes(c.item.split(' ').pop()!),
    `expected "${c.item}" in: ${reply}`,
  );
  // The isolation property: nobody else's order leaked in.
  for (const other of CUSTOMERS) {
    if (other.id === c.id) continue;
    check(
      `${c.shape}-shaped id does not see ${other.shape}-shaped id's order`,
      !reply.includes(other.item.split(' ').pop()!),
      `"${other.item}" leaked into ${c.id}'s reply: ${reply}`,
    );
  }
}

console.log('\n=== 3. the store on disk keeps them in separate rows ===');
for (const c of CUSTOMERS) {
  const facts = await factsFor(c.id);
  const ownName = c.name.toLowerCase();
  check(
    `${c.shape}-shaped id has its own facts row`,
    facts.some((f) => f.includes(ownName)),
    `no fact names ${c.name}: ${JSON.stringify(facts)}`,
  );
  for (const other of CUSTOMERS) {
    if (other.id === c.id) continue;
    check(
      `${c.shape}-shaped id's row is free of ${other.name}`,
      !facts.some((f) => f.includes(other.name.toLowerCase())),
      `${other.name} appears in ${c.id}'s row: ${JSON.stringify(facts)}`,
    );
  }
}

console.log('\n=== 4. a malformed id is refused, and the agent still works ===');
// `alice/bob` is outside the allow-list. Fail closed: no memory surface at all,
// rather than memory stored under a key that could collide with another owner.
const malformedReply = await turn('alice/bob', "Hi, I'm Sam and I always order eclairs.");
console.log(`  [slash] alice/bob\n     < ${malformedReply}`);
check(
  'the turn still completes for a malformed id',
  malformedReply.length > 0,
  'the agent produced no reply at all — withholding memory must not break the turn',
);
const malformedFacts = await factsFor('alice/bob');
check(
  'nothing was written under the malformed id',
  malformedFacts.length === 0,
  `a row exists for alice/bob: ${JSON.stringify(malformedFacts)}`,
);
// And the decisive one — it must not have landed on a sanitised neighbour either.
const sanitisedNeighbour = await factsFor('alice_bob');
check(
  "the malformed id did not land on a sanitised neighbour's row",
  sanitisedNeighbour.length === 0,
  `alice/bob's data appeared under alice_bob: ${JSON.stringify(sanitisedNeighbour)}`,
);

// The reply above is not evidence of anything: the model was echoing the turn it
// had just been given. Nothing persisted is only provable in a NEW session, where
// the only route to "eclairs" would be memory.
const malformedRecall = (await turn('alice/bob', 'What is my usual order?')).toLowerCase();
console.log(`  [slash] alice/bob, new session\n     < ${malformedRecall}`);
check(
  'a malformed id recalls nothing in a new session',
  !malformedRecall.includes('eclair'),
  `memory persisted for a refused owner: ${malformedRecall}`,
);

console.log('\n=== 5. a hand-seeded block file does not break listing ===');
// Write one block through the store, so the directory holds a name the store
// itself produced alongside one it did not. The model is not asked to call
// `memory_block` here — whether it chooses to is a prompt question, and this
// check is about the store.
await blockStore.saveBlock(
  { key: 'USER', scope: 'user', content: 'prefers a paper bag', charLimit: 1000 },
  'maya@example.com',
);

// The directory name is derived, never hardcoded. Writing the literal
// `maya%40example.com` here is what the FIRST run of this example did, and it
// silently tested nothing: the fix stopped escaping '@', so the seed landed in
// a directory the store never reads. A path spelled by hand encodes the
// encoder's behaviour at the moment it was typed.
const seededDir = join(root, 'blocks', 'user', encodeFileSegment('maya@example.com'));
mkdirSync(seededDir, { recursive: true });
// An admin script seeds a block by hand. '50%' is not valid percent-encoding,
// and decoding it used to throw URIError and take the whole listing with it.
writeFileSync(join(seededDir, '50%.md'), 'seeded by an admin script');

const listed = await blockStore.listBlocks('user', 'maya@example.com');
console.log(`  dir        -> ${seededDir.slice(root.length + 1)}`);
console.log(`  listBlocks -> ${JSON.stringify(listed)}`);
check(
  'the email-shaped owner keeps an unescaped @ in its path',
  seededDir.endsWith('maya@example.com'),
  `escaped after all: ${seededDir}`,
);
check(
  'listBlocks survives a hand-seeded file with a bare %',
  listed.includes('50%'),
  `expected '50%' in ${JSON.stringify(listed)}`,
);
check(
  'and the store-written block is listed beside it',
  listed.includes('USER'),
  `expected 'USER' in ${JSON.stringify(listed)}`,
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
