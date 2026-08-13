/**
 * Redis FlowDefinitionsStore conformance.
 * Mock always runs (SET NX is implemented like real Redis).
 * Live Redis is keyed on REDIS_URL and skips when unset.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { createClient, type RedisClientType } from 'redis';
import { flowDefinitionsStoreConformanceCases } from '@kuralle-agents/core/flows/definition/testing';
import { RedisFlowDefinitionsStore } from '../RedisFlowDefinitionsStore.js';
import type { RedisClientLike } from '../RedisSessionStore.js';

const REDIS_URL = process.env.REDIS_URL;

function createMockRedisClient(): RedisClientLike {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const getSet = (key: string): Set<string> => {
    let members = sets.get(key);
    if (!members) {
      members = new Set();
      sets.set(key, members);
    }
    return members;
  };
  return {
    async get(key: string) {
      return kv.get(key) ?? null;
    },
    async set(key: string, value: string, nx?: { NX?: boolean } | string) {
      const nxFlag = nx === 'NX' || (typeof nx === 'object' && nx?.NX === true);
      if (nxFlag && kv.has(key)) return null;
      kv.set(key, value);
      return 'OK';
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const key of keys) {
        if (kv.delete(key)) n += 1;
        sets.delete(key);
      }
      return n;
    },
    async mget(...keys: string[]) {
      return keys.map(key => kv.get(key) ?? null);
    },
    async sadd(key: string, ...members: string[]) {
      const set = getSet(key);
      let added = 0;
      for (const member of members) {
        if (!set.has(member)) {
          set.add(member);
          added += 1;
        }
      }
      return added;
    },
    async smembers(key: string) {
      return Array.from(getSet(key));
    },
  };
}

describe('RedisFlowDefinitionsStore mock conformance', () => {
  for (const testCase of flowDefinitionsStoreConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(new RedisFlowDefinitionsStore({ client: createMockRedisClient() }));
    });
  }
});

describe.skipIf(!REDIS_URL)('RedisFlowDefinitionsStore live conformance', () => {
  let client: RedisClientType;

  beforeAll(async () => {
    client = createClient({ url: REDIS_URL });
    client.on('error', () => {});
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
  });

  for (const testCase of flowDefinitionsStoreConformanceCases) {
    it(testCase.name, async () => {
      const prefix = `flowdef_${crypto.randomUUID()}`;
      await testCase.run(new RedisFlowDefinitionsStore({ client: client as unknown as RedisClientLike, prefix }));
    });
  }
});
