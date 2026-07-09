import type { RedisLikeClient } from './redis-client.js';
import type { WindowState, WindowStore } from './window-store.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function windowKey(prefix: string, threadId: string): string {
  return `${prefix}win:${threadId}`;
}

function parseExpiryMs(raw: string): Date | null {
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

export function createRedisWindowStore(
  client: RedisLikeClient,
  opts?: { keyPrefix?: string },
): WindowStore {
  const prefix = opts?.keyPrefix ?? '';

  return {
    async get(threadId: string): Promise<WindowState> {
      const raw = await client.get(windowKey(prefix, threadId));
      if (raw === null) return { open: false, expiresAt: null };
      const expiresAt = parseExpiryMs(raw);
      if (!expiresAt) return { open: false, expiresAt: null };
      const now = new Date();
      return expiresAt > now
        ? { open: true, expiresAt }
        : { open: false, expiresAt };
    },

    async recordInbound(threadId: string, ts: Date): Promise<void> {
      const key = windowKey(prefix, threadId);
      const candidate = new Date(ts.getTime() + DEFAULT_WINDOW_MS);
      const raw = await client.get(key);
      let expiry = candidate;
      if (raw !== null) {
        const existing = parseExpiryMs(raw);
        if (existing && existing > expiry) expiry = existing;
      }
      const pxMs = Math.max(1, expiry.getTime() - Date.now());
      await client.set(key, String(expiry.getTime()), { pxMs });
    },

    async recordExpiry(threadId: string, at: Date): Promise<void> {
      const key = windowKey(prefix, threadId);
      const pxMs = Math.max(1, at.getTime() - Date.now());
      await client.set(key, String(at.getTime()), { pxMs });
    },
  };
}
