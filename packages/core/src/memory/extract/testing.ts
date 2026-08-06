/**
 * Conformance cases every `ExtractedValueStore` backend must pass.
 *
 * Framework-neutral on purpose. `packages/core` runs `bun:test`, while
 * `postgres-store`, `redis-store` and `cf-agent` run `node:test` against their
 * built `dist/`. A suite written against one runner is a suite the other
 * backends cannot run — and those are exactly the backends most likely to
 * diverge, so the shared contract would be lost where it matters most.
 *
 * Each case is `{ name, run(store) }` and throws on failure. Wrap them in
 * whatever runner the package uses:
 *
 *     for (const c of extractedValueStoreConformanceCases) {
 *       it(c.name, async () => { await c.run(makeStore()); });
 *     }
 */
import type { ExtractedValueStore } from './store.js';

export interface ExtractedValueStoreConformanceCase {
  name: string;
  run(store: ExtractedValueStore): Promise<void>;
}

function fail(message: string): never {
  throw new Error(`ExtractedValueStore conformance: ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${what} — expected ${e}, got ${a}`);
}

const ISO = '2026-08-06T00:00:00.000Z';

/**
 * Owner pairs that MUST NOT collide.
 *
 * Every pair here collides today in `FilePersistentMemoryStore` (whose `safe()`
 * maps `/`, `\` and `..` onto a single `_`) or in `RedisPersistentMemoryStore`
 * (whose key composition is unescaped around `:`). Those are the block stores,
 * not these — this table exists so the extracted-value backends never acquire
 * the same defect.
 */
const COLLIDING_OWNER_CANDIDATES: ReadonlyArray<readonly [string, string]> = [
  ['alice/bob', 'alice_bob'],
  ['alice\\bob', 'alice_bob'],
  ['alice//bob', 'alice/bob'],
  ['a:b', 'a'],
  ['..', '_'],
  ['user.1', 'user%2E1'],
];

export const extractedValueStoreConformanceCases: ReadonlyArray<ExtractedValueStoreConformanceCase> =
  [
    {
      name: 'returns null for a slug that was never written',
      async run(store) {
        const got = await store.load('user', 'alice', 'never-written');
        if (got !== null) fail(`expected null for a missing slug, got ${JSON.stringify(got)}`);
      },
    },
    {
      name: 'round-trips a typed value',
      async run(store) {
        const value = {
          slug: 'support-profile',
          scope: 'user' as const,
          value: { os: 'macOS', nodeVersion: '22.3.0', tags: ['a', 'b'] },
          updatedAt: ISO,
        };
        await store.save(value, 'alice');
        assertEqual(await store.load('user', 'alice', 'support-profile'), value, 'round trip');
      },
    },
    {
      name: 'replaces rather than appends on a second save',
      async run(store) {
        const base = { slug: 's', scope: 'user' as const, updatedAt: ISO };
        await store.save({ ...base, value: { n: 1 } }, 'alice');
        await store.save({ ...base, value: { n: 2 } }, 'alice');
        assertEqual((await store.load('user', 'alice', 's'))?.value, { n: 2 }, 'replace');
      },
    },
    {
      name: 'separates owners',
      async run(store) {
        const base = { slug: 's', scope: 'user' as const, updatedAt: ISO };
        await store.save({ ...base, value: 'alice-value' }, 'alice');
        await store.save({ ...base, value: 'bob-value' }, 'bob');
        assertEqual((await store.load('user', 'alice', 's'))?.value, 'alice-value', 'alice');
        assertEqual((await store.load('user', 'bob', 's'))?.value, 'bob-value', 'bob');
      },
    },
    {
      name: 'separates scopes for one owner',
      async run(store) {
        const base = { slug: 's', updatedAt: ISO };
        await store.save({ ...base, scope: 'user', value: 'u' }, 'o');
        await store.save({ ...base, scope: 'agent', value: 'a' }, 'o');
        assertEqual((await store.load('user', 'o', 's'))?.value, 'u', 'user scope');
        assertEqual((await store.load('agent', 'o', 's'))?.value, 'a', 'agent scope');
      },
    },
    {
      name: 'separates slugs for one owner',
      async run(store) {
        const base = { scope: 'user' as const, updatedAt: ISO };
        await store.save({ ...base, slug: 'one', value: 1 }, 'o');
        await store.save({ ...base, slug: 'two', value: 2 }, 'o');
        assertEqual((await store.load('user', 'o', 'one'))?.value, 1, 'slug one');
        assertEqual((await store.load('user', 'o', 'two'))?.value, 2, 'slug two');
      },
    },
    {
      name: 'never lets two distinct owners share a row',
      async run(store) {
        for (const [left, right] of COLLIDING_OWNER_CANDIDATES) {
          const base = { slug: 's', scope: 'user' as const, updatedAt: ISO };
          await store.save({ ...base, value: `left:${left}` }, left);
          await store.save({ ...base, value: `right:${right}` }, right);
          assertEqual(
            (await store.load('user', left, 's'))?.value,
            `left:${left}`,
            `owner ${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
          );
          assertEqual(
            (await store.load('user', right, 's'))?.value,
            `right:${right}`,
            `owner ${JSON.stringify(right)} vs ${JSON.stringify(left)}`,
          );
        }
      },
    },
    {
      name: 'delete removes only its own row, and is a no-op when missing',
      async run(store) {
        const base = { slug: 's', scope: 'user' as const, updatedAt: ISO };
        await store.save({ ...base, value: 'a' }, 'alice');
        await store.save({ ...base, value: 'b' }, 'bob');
        await store.delete('user', 'alice', 's');
        const gone = await store.load('user', 'alice', 's');
        if (gone !== null) fail(`delete left a row: ${JSON.stringify(gone)}`);
        assertEqual((await store.load('user', 'bob', 's'))?.value, 'b', 'sibling survived');
        await store.delete('user', 'alice', 's'); // must not throw
      },
    },
    {
      name: 'preserves value types through a round trip',
      async run(store) {
        const base = { scope: 'user' as const, updatedAt: ISO };
        await store.save({ ...base, slug: 'arr', value: [1, 'two', null] }, 'o');
        await store.save({ ...base, slug: 'nested', value: { a: { b: [true] } } }, 'o');
        await store.save({ ...base, slug: 'str', value: 'plain' }, 'o');
        assertEqual((await store.load('user', 'o', 'arr'))?.value, [1, 'two', null], 'array');
        assertEqual((await store.load('user', 'o', 'nested'))?.value, { a: { b: [true] } }, 'nested');
        assertEqual((await store.load('user', 'o', 'str'))?.value, 'plain', 'string');
      },
    },
    {
      name: 'does not alias a value returned from load',
      async run(store) {
        await store.save({ slug: 's', scope: 'user', value: { n: 1 }, updatedAt: ISO }, 'o');
        const first = (await store.load('user', 'o', 's')) as { value: { n: number } };
        first.value.n = 999;
        assertEqual((await store.load('user', 'o', 's'))?.value, { n: 1 }, 'load aliasing');
      },
    },
    {
      name: 'does not alias a caller-held object',
      async run(store) {
        const mutable = { slug: 's', scope: 'user' as const, value: { n: 1 }, updatedAt: ISO };
        await store.save(mutable, 'o');
        mutable.value.n = 999;
        assertEqual((await store.load('user', 'o', 's'))?.value, { n: 1 }, 'save aliasing');
      },
    },
  ];
