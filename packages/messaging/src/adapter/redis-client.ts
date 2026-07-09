/**
 * Minimal Redis client surface for durable messaging stores.
 * Satisfied by ioredis, node-redis, and @upstash/redis — pass the native client
 * through a thin adapter that maps `set` to PX/NX when `opts` is provided.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    opts?: { pxMs?: number; nx?: boolean },
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function redisSetSucceeded(result: unknown): boolean {
  if (result == null) return false;
  if (result === 'OK' || result === true) return true;
  return false;
}
