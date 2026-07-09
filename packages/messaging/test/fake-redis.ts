import type { RedisLikeClient } from '../src/adapter/redis-client.js';

interface FakeEntry {
  value: string;
  expiresAtMs: number | null;
}

export function createFakeRedis(): RedisLikeClient {
  const store = new Map<string, FakeEntry>();

  const isExpired = (entry: FakeEntry): boolean =>
    entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now();

  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry || isExpired(entry)) {
        if (entry && isExpired(entry)) store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, opts) {
      const entry = store.get(key);
      if (opts?.nx && entry && !isExpired(entry)) return null;
      const expiresAtMs =
        opts?.pxMs != null ? Date.now() + opts.pxMs : null;
      store.set(key, { value, expiresAtMs });
      return 'OK';
    },
    async del(key) {
      store.delete(key);
      return 1;
    },
  };
}
