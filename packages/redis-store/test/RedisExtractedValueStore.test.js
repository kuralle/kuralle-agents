import { describe, it } from 'node:test';
import { extractedValueStoreConformanceCases } from '@kuralle-agents/core';
import { RedisExtractedValueStore } from '../dist/RedisExtractedValueStore.js';

function createMockRedisClient() {
  const store = new Map();

  return {
    _store: store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
    async del(key) {
      store.delete(key);
      return 1;
    },
  };
}

function makeStore() {
  return new RedisExtractedValueStore({ client: createMockRedisClient(), prefix: 'test' });
}

describe('RedisExtractedValueStore', () => {
  for (const c of extractedValueStoreConformanceCases) {
    it(c.name, async () => {
      await c.run(makeStore());
    });
  }
});
