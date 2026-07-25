/**
 * Adversarial exploit tests for the stream reshape — try to BREAK the filter.
 *
 * These are the attacks the brief mandates:
 *   1. a part with a `channel` contradicting PART_CHANNEL  -> filter must still hold
 *   2. an unknown `type` reaching the filter               -> fail closed (blocked)
 *   3. a client-channel part smuggling internal data       -> classification is by type,
 *      not payload content; verify the contract explicitly
 *   4. prototype-pollution / __proto__ keys in a payload   -> must not leak or corrupt
 *
 * Run: bun run packages/hono-server/examples/stream-contract/review-adversarial.ts
 */
import { shouldEmit, sanitizeForClient } from '@kuralle-agents/hono-server';
import { PART_CHANNEL } from '@kuralle-agents/core';

// The filter's public type is `(part: StreamPart, filter) => boolean`. To attack
// it we must bypass the type system (a real emitter cannot construct a lying
// part through the typed StreamPart — that is the reshape's whole point). So we
// cast to the input type the way a hostile/buggy upstream might.
type AnyPart = Parameters<typeof shouldEmit>[0];
const asPart = (p: object) => p as AnyPart;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
  }
}

console.log('=== Attack 1: a part that lies about its channel ===');
// 'text-delta' is classified 'client' by PART_CHANNEL. A hostile part self-
// declares 'internal' to try to suppress itself, OR a client type self-declares
// 'internal' hoping the filter will trust part.channel and block it. Either way
// the filter MUST use PART_CHANNEL[type], not part.channel.
const lyingInternal = asPart({
  channel: 'internal',
  type: 'text-delta',
  payload: { id: 't1', delta: 'secret' },
});
check(
  "lying 'internal' on a client type still EMITS under 'safe' (filter trusts PART_CHANNEL, not part.channel)",
  shouldEmit(lyingInternal, 'safe') === true,
  `got ${shouldEmit(lyingInternal, 'safe')}`,
);
const lyingClient = asPart({
  channel: 'client',
  type: 'tool-call',
  payload: { toolName: 'x', args: {} },
});
check(
  "lying 'client' on an internal type still BLOCKED under 'safe'",
  shouldEmit(lyingClient, 'safe') === false,
  `got ${shouldEmit(lyingClient, 'safe')}`,
);

console.log('\n=== Attack 2: unknown type reaches the filter ===');
const unknownType = asPart({
  channel: 'client',
  type: 'totally-fabricated-debug-event',
  payload: { secret: 'api_key_123' },
});
check(
  "unknown type BLOCKED under 'safe' (PART_CHANNEL[type] === undefined !== 'client')",
  shouldEmit(unknownType, 'safe') === false,
  `got ${shouldEmit(unknownType, 'safe')}`,
);
const unknownTypeAll = asPart({
  channel: 'internal',
  type: 'fabricated',
  payload: {},
});
check(
  "unknown type passes under 'all' (all is unconditional)",
  shouldEmit(unknownTypeAll, 'all') === true,
);

console.log('\n=== Attack 3: client-channel type smuggling internal-looking data ===');
// Classification is BY TYPE, not by payload introspection. A 'custom' part
// (internal) carrying harmless data is still blocked; a 'done' part (client)
// carrying odd-looking data still emits. This is the contract.
check(
  "'custom' (internal) blocked even with benign payload",
  shouldEmit(asPart({ channel: 'internal', type: 'custom', payload: { name: 'x', data: 1 } }), 'safe') === false,
);
check(
  "'done' (client) emits even with unusual payload shape",
  shouldEmit(asPart({ channel: 'client', type: 'done', payload: { sessionId: 's', usage: {} } }), 'safe') === true,
);

console.log('\n=== Attack 4: prototype-pollution / __proto__ in error payload ===');
// sanitizeForClient spreads the incoming part. A hostile payload with __proto__
// must not pollute Object.prototype. Verify the global prototype is intact after
// sanitize and the safe message replaces the hostile one.
const original = console.error;
console.error = () => {};
const hostile = asPart({
  channel: 'client',
  type: 'error',
  payload: {
    error: 'leaked stack',
    __proto__: { polluted: true },
    constructor: { prototype: { polluted: true } },
  },
});
const safe = sanitizeForClient(hostile);
console.error = original;
check(
  'sanitized error carries generic message, not hostile payload',
  (safe as { payload?: { error?: string } }).payload?.error === 'An error occurred. Please try again.',
  `got ${(safe as { payload?: { error?: string } }).payload?.error}`,
);
check(
  'Object.prototype NOT polluted by __proto__ in payload',
  ({} as { polluted?: boolean }).polluted === undefined,
  'prototype was polluted!',
);
check(
  'sanitized part still classifies as client/error',
  shouldEmit(safe, 'safe') === true,
);

console.log('\n=== Invariant: PART_CHANNEL is the single source of truth on the wire ===');
// Every type the filter could see must have a classification; the filter must
// agree with PART_CHANNEL for every classified type. This is the property the
// hono safe/all HTTP test also verified end-to-end.
let allConsistent = true;
for (const [type, channel] of Object.entries(PART_CHANNEL)) {
  const emitted = shouldEmit(asPart({ channel, type, payload: {} }), 'safe');
  const expected = channel === 'client';
  if (emitted !== expected) {
    allConsistent = false;
    console.error(`  drift at ${type}: filter=${emitted} expected=${expected}`);
  }
}
check('shouldEmit(safe) === (PART_CHANNEL[type] === "client") for ALL 33 types', allConsistent);

console.log(`\n=== Adversarial ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
