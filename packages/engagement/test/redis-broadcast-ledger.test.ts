import { describe, it, expect } from 'bun:test';
import { createFakeRedis } from '../../messaging/test/fake-redis.js';
import {
  createInMemoryBroadcastLedger,
  createRedisBroadcastLedger,
} from '../src/broadcast-ledger.js';

describe('redis_broadcast_ledger_atomic_putifabsent', () => {
  it('returns true once then false for the same key', async () => {
    const ledger = createRedisBroadcastLedger(createFakeRedis());
    expect(await ledger.putIfAbsent('camp-1:cust-a')).toBe(true);
    expect(await ledger.putIfAbsent('camp-1:cust-a')).toBe(false);
    expect(await ledger.putIfAbsent('camp-1:cust-b')).toBe(true);
  });
});

describe('redis_broadcast_ledger_parity_with_in_memory', () => {
  it('matches in-memory idempotency for campaign recipient keys', async () => {
    const keys = ['camp-1:cust-a', 'camp-1:cust-b', 'camp-1:cust-a'];
    const memory = createInMemoryBroadcastLedger();
    const redis = createRedisBroadcastLedger(createFakeRedis());

    const memoryResults: boolean[] = [];
    const redisResults: boolean[] = [];
    for (const key of keys) {
      memoryResults.push(await memory.putIfAbsent(key));
      redisResults.push(await redis.putIfAbsent(key));
    }

    expect(redisResults).toEqual(memoryResults);
    expect(redisResults).toEqual([true, true, false]);
  });
});
