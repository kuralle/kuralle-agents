import { describe, it, expect } from 'bun:test';
import {
  runPersistentMemoryDurabilityContract,
  runPersistentMemoryStoreContract,
} from '@kuralle-agents/core/memory/testing';
import { RedisPersistentMemoryStore } from '../RedisPersistentMemoryStore.js';

function createMockRedisClient() {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const getSet = (key: string): Set<string> => {
    let s = sets.get(key);
    if (!s) {
      s = new Set();
      sets.set(key, s);
    }
    return s;
  };

  return {
    kv,
    client: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async set(key: string, value: string) {
        kv.set(key, value);
        return 'OK';
      },
      async del(...keys: string[]) {
        let n = 0;
        for (const k of keys) {
          if (kv.delete(k)) {
            n++;
          }
          sets.delete(k);
        }
        return n;
      },
      async sadd(key: string, ...members: string[]) {
        const s = getSet(key);
        let added = 0;
        for (const m of members) {
          if (!s.has(m)) {
            s.add(m);
            added++;
          }
        }
        return added;
      },
      async srem(key: string, ...members: string[]) {
        const s = getSet(key);
        let removed = 0;
        for (const m of members) {
          if (s.delete(m)) {
            removed++;
          }
        }
        return removed;
      },
      async smembers(key: string) {
        return Array.from(getSet(key));
      },
    },
  };
}

runPersistentMemoryStoreContract(async () => {
  const { client } = createMockRedisClient();
  return new RedisPersistentMemoryStore({ client: client as never });
});

runPersistentMemoryDurabilityContract(async () => {
  const { client } = createMockRedisClient();
  return {
    storeA: new RedisPersistentMemoryStore({ client: client as never }),
    storeB: new RedisPersistentMemoryStore({ client: client as never }),
  };
});

describe('RedisPersistentMemoryStore fake client', () => {
  // contract + durability registered above
});

/**
 * Key stability, pinned as literals on purpose.
 *
 * An adversarial review found that encoding every allow-listed character —
 * '@', ':', '|', '+', '~' — silently orphaned existing blocks: an upgrading
 * deployment could no longer find any email-shaped or tenant-prefixed owner's
 * working memory, with no error and no warning. Redis only needs ':' escaped,
 * because ':' is the separator this store composes on; the rest are inert
 * inside a Redis key and must pass through untouched.
 *
 * These are golden strings rather than a round-trip assertion deliberately.
 * A round trip stays green no matter how much the encoder widens — it is the
 * *stability* of the byte sequence that protects existing data, so that is
 * what gets asserted.
 */
describe('Redis working-memory key stability', () => {
  const store = new RedisPersistentMemoryStore({
    client: createMockRedisClient().client as never,
    prefix: 'kuralle',
  });
  const keyOf = (owner: string, key = 'USER') =>
    (store as unknown as { blockKey(s: string, o: string, k: string): string }).blockKey(
      'user',
      owner,
      key,
    );

  it('leaves every allow-listed character except ":" untouched', () => {
    expect(keyOf('maya@example.com')).toBe('kuralle:wm:user:maya@example.com:USER');
    expect(keyOf('google-oauth2|123')).toBe('kuralle:wm:user:google-oauth2|123:USER');
    expect(keyOf('user+tag')).toBe('kuralle:wm:user:user+tag:USER');
    expect(keyOf('user~1')).toBe('kuralle:wm:user:user~1:USER');
    expect(keyOf('a.b_c-d')).toBe('kuralle:wm:user:a.b_c-d:USER');
  });

  it('escapes ":" — the one character that would rearrange the key', () => {
    expect(keyOf('tenant:user')).toBe('kuralle:wm:user:tenant%3Auser:USER');
    // and therefore the rearrangement is no longer expressible
    expect(keyOf('a', 'b:K')).not.toBe(keyOf('a:b', 'K'));
  });

  it('escapes "%" so the encoding stays injective', () => {
    expect(keyOf('100%')).toBe('kuralle:wm:user:100%25:USER');
    expect(keyOf('100%25')).not.toBe(keyOf('100%'));
  });
});
