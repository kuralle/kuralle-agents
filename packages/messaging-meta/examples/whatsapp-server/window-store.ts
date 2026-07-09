import type { RedisLikeClient, WindowStore } from '@kuralle-agents/messaging';
import { InMemoryWindowStore, createRedisWindowStore } from '@kuralle-agents/messaging';

export async function createWindowStore(): Promise<WindowStore> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    return new InMemoryWindowStore();
  }

  try {
    const { createClient } = await import('redis');
    const client = createClient({ url: redisUrl });
    client.on('error', (err: Error) => {
      console.error('[windowStore] redis error:', err.message);
    });
    await client.connect();

    const redisLike: RedisLikeClient = {
      get: (key) => client.get(key),
      del: (key) => client.del(key),
      set: (key, value, opts) => {
        if (opts?.nx) {
          return client.set(key, value, { PX: opts.pxMs ?? 0, NX: true });
        }
        if (opts?.pxMs != null) {
          return client.set(key, value, { PX: opts.pxMs });
        }
        return client.set(key, value);
      },
    };

    console.log('[windowStore] using Redis (REDIS_URL)');
    return createRedisWindowStore(redisLike, { keyPrefix: 'whatsapp-server:' });
  } catch (err) {
    console.error(
      '[windowStore] REDIS_URL set but redis client unavailable:',
      (err as Error).message,
    );
    console.error('[windowStore] falling back to InMemoryWindowStore');
    return new InMemoryWindowStore();
  }
}
