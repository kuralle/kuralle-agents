import { describe, it, expect } from 'bun:test';
import { createRedisWindowStore } from '../src/adapter/redis-window-store.js';
import { createFakeRedis } from './fake-redis.js';

describe('redis_window_store_fail_closed_and_open', () => {
  it('unknown thread is fail-closed', async () => {
    const store = createRedisWindowStore(createFakeRedis());
    const state = await store.get('unknown-thread');
    expect(state).toEqual({ open: false, expiresAt: null });
  });

  it('after recordInbound, window is open', async () => {
    const store = createRedisWindowStore(createFakeRedis());
    const thread = 'thread-1';
    const now = new Date();
    await store.recordInbound(thread, now);
    const state = await store.get(thread);
    expect(state.open).toBe(true);
    if (state.open) {
      expect(state.expiresAt.getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    }
  });

  it('past expiry is closed with expiresAt set', async () => {
    const store = createRedisWindowStore(createFakeRedis());
    const thread = 'thread-1';
    const pastDate = new Date(Date.now() - 60 * 60 * 1000);
    await store.recordExpiry(thread, pastDate);
    const state = await store.get(thread);
    expect(state).toEqual({ open: false, expiresAt: pastDate });
  });
});

describe('redis_window_store_only_extends', () => {
  it('recordInbound never shrinks an existing window', async () => {
    const client = createFakeRedis();
    const store = createRedisWindowStore(client);
    const thread = 'thread-extend';
    const laterInbound = new Date(Date.now() + 60 * 60 * 1000);
    const earlierInbound = new Date(laterInbound.getTime() - 24 * 60 * 60 * 1000);

    await store.recordInbound(thread, laterInbound);
    const afterLater = await store.get(thread);
    expect(afterLater.open).toBe(true);
    if (!afterLater.open) throw new Error('expected open window');

    await store.recordInbound(thread, earlierInbound);
    const afterEarlier = await store.get(thread);
    expect(afterEarlier.open).toBe(true);
    if (!afterEarlier.open) throw new Error('expected open window');
    expect(afterEarlier.expiresAt.getTime()).toBe(afterLater.expiresAt.getTime());
  });
});
