/**
 * Conformance suite every `ExtractedValueStore` backend must pass.
 *
 * Shared rather than per-package so a new backend cannot ship with a weaker
 * contract than the others, and so the isolation cases below are checked
 * everywhere rather than only where someone remembered to write them.
 */
import { describe, expect, it } from 'bun:test';
import type { ExtractedValueStore } from './store.js';

/**
 * Owner pairs that MUST NOT collide.
 *
 * Every pair here collides today in `FilePersistentMemoryStore` (whose `safe()`
 * maps `/`, `\` and `..` to one `_`) or in `RedisPersistentMemoryStore` (whose
 * key composition is unescaped around `:`). Those are the block stores, not
 * these — this table exists so the extracted-value backends never acquire the
 * same defect.
 */
const COLLIDING_OWNER_CANDIDATES: ReadonlyArray<readonly [string, string]> = [
  ['alice/bob', 'alice_bob'],
  ['alice\\bob', 'alice_bob'],
  ['alice//bob', 'alice/bob'],
  ['a:b', 'a'],
  ['..', '_'],
  ['user.1', 'user%2E1'],
];

export function runExtractedValueStoreConformance(
  name: string,
  makeStore: () => ExtractedValueStore | Promise<ExtractedValueStore>,
): void {
  describe(`ExtractedValueStore conformance: ${name}`, () => {
    it('returns null for a slug that was never written', async () => {
      const store = await makeStore();
      expect(await store.load('user', 'alice', 'never-written')).toBeNull();
    });

    it('round-trips a typed value', async () => {
      const store = await makeStore();
      const value = {
        slug: 'support-profile',
        scope: 'user' as const,
        value: { os: 'macOS', nodeVersion: '22.3.0', tags: ['a', 'b'] },
        updatedAt: '2026-08-06T00:00:00.000Z',
      };
      await store.save(value, 'alice');
      expect(await store.load('user', 'alice', 'support-profile')).toEqual(value);
    });

    it('replaces rather than appends on a second save', async () => {
      const store = await makeStore();
      const base = { slug: 's', scope: 'user' as const, updatedAt: '2026-08-06T00:00:00.000Z' };
      await store.save({ ...base, value: { n: 1 } }, 'alice');
      await store.save({ ...base, value: { n: 2 } }, 'alice');
      expect((await store.load('user', 'alice', 's'))?.value).toEqual({ n: 2 });
    });

    it('separates owners', async () => {
      const store = await makeStore();
      const base = { slug: 's', scope: 'user' as const, updatedAt: '2026-08-06T00:00:00.000Z' };
      await store.save({ ...base, value: 'alice-value' }, 'alice');
      await store.save({ ...base, value: 'bob-value' }, 'bob');
      expect((await store.load('user', 'alice', 's'))?.value).toBe('alice-value');
      expect((await store.load('user', 'bob', 's'))?.value).toBe('bob-value');
    });

    it('separates scopes for one owner', async () => {
      const store = await makeStore();
      const base = { slug: 's', updatedAt: '2026-08-06T00:00:00.000Z' };
      await store.save({ ...base, scope: 'user', value: 'u' }, 'o');
      await store.save({ ...base, scope: 'agent', value: 'a' }, 'o');
      expect((await store.load('user', 'o', 's'))?.value).toBe('u');
      expect((await store.load('agent', 'o', 's'))?.value).toBe('a');
    });

    it('separates slugs for one owner', async () => {
      const store = await makeStore();
      const base = { scope: 'user' as const, updatedAt: '2026-08-06T00:00:00.000Z' };
      await store.save({ ...base, slug: 'one', value: 1 }, 'o');
      await store.save({ ...base, slug: 'two', value: 2 }, 'o');
      expect((await store.load('user', 'o', 'one'))?.value).toBe(1);
      expect((await store.load('user', 'o', 'two'))?.value).toBe(2);
    });

    it('never lets two distinct owners share a row', async () => {
      const store = await makeStore();
      for (const [left, right] of COLLIDING_OWNER_CANDIDATES) {
        const base = { slug: 's', scope: 'user' as const, updatedAt: '2026-08-06T00:00:00.000Z' };
        await store.save({ ...base, value: `left:${left}` }, left);
        await store.save({ ...base, value: `right:${right}` }, right);
        expect((await store.load('user', left, 's'))?.value).toBe(`left:${left}`);
        expect((await store.load('user', right, 's'))?.value).toBe(`right:${right}`);
      }
    });

    it('delete removes only its own row, and is a no-op when missing', async () => {
      const store = await makeStore();
      const base = { slug: 's', scope: 'user' as const, updatedAt: '2026-08-06T00:00:00.000Z' };
      await store.save({ ...base, value: 'a' }, 'alice');
      await store.save({ ...base, value: 'b' }, 'bob');
      await store.delete('user', 'alice', 's');
      expect(await store.load('user', 'alice', 's')).toBeNull();
      expect((await store.load('user', 'bob', 's'))?.value).toBe('b');
      // Second delete must not throw.
      await store.delete('user', 'alice', 's');
    });

    it('preserves value types through a round trip', async () => {
      const store = await makeStore();
      const base = { scope: 'user' as const, updatedAt: '2026-08-06T00:00:00.000Z' };
      await store.save({ ...base, slug: 'arr', value: [1, 'two', null] }, 'o');
      await store.save({ ...base, slug: 'nested', value: { a: { b: [true] } } }, 'o');
      await store.save({ ...base, slug: 'str', value: 'plain' }, 'o');
      expect((await store.load('user', 'o', 'arr'))?.value).toEqual([1, 'two', null]);
      expect((await store.load('user', 'o', 'nested'))?.value).toEqual({ a: { b: [true] } });
      expect((await store.load('user', 'o', 'str'))?.value).toBe('plain');
    });

    it('does not alias a value returned from load', async () => {
      const store = await makeStore();
      await store.save(
        { slug: 's', scope: 'user', value: { n: 1 }, updatedAt: 'x' },
        'o',
      );
      const first = (await store.load('user', 'o', 's')) as { value: { n: number } };
      first.value.n = 999;
      expect((await store.load('user', 'o', 's'))?.value).toEqual({ n: 1 });
    });

    it('does not alias a caller-held object', async () => {
      const store = await makeStore();
      const mutable = { slug: 's', scope: 'user' as const, value: { n: 1 }, updatedAt: 'x' };
      await store.save(mutable, 'o');
      mutable.value.n = 999;
      expect((await store.load('user', 'o', 's'))?.value).toEqual({ n: 1 });
    });
  });
}
