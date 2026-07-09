import { describe, it, expect } from 'bun:test';
import { InMemoryWindowStore } from '../src/adapter/window-store.js';

describe('window_store_fail_closed', () => {
  it('unknown thread is fail-closed', async () => {
    const store = new InMemoryWindowStore();
    const state = await store.get('unknown-thread');
    expect(state).toEqual({ open: false, expiresAt: null });
  });

  it('after recordInbound, window is open', async () => {
    const store = new InMemoryWindowStore();
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
    const store = new InMemoryWindowStore();
    const thread = 'thread-1';
    const pastDate = new Date(Date.now() - 60 * 60 * 1000);
    await store.recordExpiry(thread, pastDate);
    const state = await store.get(thread);
    expect(state).toEqual({ open: false, expiresAt: pastDate });
  });
});
