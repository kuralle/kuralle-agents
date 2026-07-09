import { describe } from 'bun:test';
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
