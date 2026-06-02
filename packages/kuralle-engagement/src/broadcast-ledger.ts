import {
  redisSetSucceeded,
  type RedisLikeClient,
} from '@kuralle-agents/messaging';

export interface BroadcastLedger {
  /** Atomic compare-and-set. Returns true if newly added, false if the key already existed. */
  putIfAbsent(key: string): Promise<boolean>;
}

export function createInMemoryBroadcastLedger(): BroadcastLedger {
  const seen = new Set<string>();
  return {
    async putIfAbsent(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

export function createRedisBroadcastLedger(
  client: RedisLikeClient,
  opts?: { keyPrefix?: string; ttlMs?: number },
): BroadcastLedger {
  const prefix = opts?.keyPrefix ?? '';
  return {
    async putIfAbsent(key) {
      const redisKey = `${prefix}bcast:${key}`;
      const setOpts: { nx: true; pxMs?: number } = { nx: true };
      if (opts?.ttlMs !== undefined) setOpts.pxMs = opts.ttlMs;
      const result = await client.set(redisKey, '1', setOpts);
      return redisSetSucceeded(result);
    },
  };
}
