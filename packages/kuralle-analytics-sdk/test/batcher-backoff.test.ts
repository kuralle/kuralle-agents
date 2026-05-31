import { describe, test, expect } from 'bun:test';

import { Batcher } from '../src/batcher.js';
import type { AnalyticsEvent } from '../src/schema.js';

const makeEvent = (i: number): AnalyticsEvent => ({
  sessionId: 'sess',
  agentId: 'agent',
  workspaceId: 'ws',
  type: 'custom',
  data: { i },
});

type FakeTimer = { cb: () => void; ms: number };

/** Collects scheduled timeouts so tests can assert on exact delays. */
function fakeScheduler() {
  const scheduled: FakeTimer[] = [];
  return {
    scheduled,
    scheduler: {
      setTimeout(cb: () => void, ms: number) {
        const timer = { cb, ms };
        scheduled.push(timer);
        // Fire immediately in a microtask to let async flow continue without real waits.
        queueMicrotask(() => timer.cb());
        return timer;
      },
      clearTimeout(_handle: unknown) {},
    },
  };
}

describe('Batcher exponential backoff', () => {
  test('retries with doubling delay on failure', async () => {
    const { scheduled, scheduler } = fakeScheduler();
    let attempts = 0;
    const batcher = new Batcher({
      maxBatchSize: 1,
      flushInterval: 60_000,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 30_000,
      retryMaxAttempts: 4,
      scheduler,
      onFlush: async () => {
        attempts++;
        if (attempts < 3) throw new Error('simulated failure');
      },
    });

    batcher.add(makeEvent(1)); // triggers flush immediately (batch size 1)
    // Wait for microtask-driven retry chain to settle
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(attempts).toBe(3);
    expect(scheduled.map(t => t.ms)).toEqual([100, 200]);
    batcher.destroy();
  });

  test('caps delay at retryMaxDelayMs', async () => {
    const { scheduled, scheduler } = fakeScheduler();
    const batcher = new Batcher({
      maxBatchSize: 1,
      flushInterval: 60_000,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 3_000,
      retryMaxAttempts: 6,
      scheduler,
      onFlush: async () => { throw new Error('always fails'); },
    });

    batcher.add(makeEvent(1));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Backoff should be 1000, 2000, 3000 (capped), 3000, 3000 for attempts 1..5 failing.
    expect(scheduled.map(t => t.ms)).toEqual([1000, 2000, 3000, 3000, 3000]);
    batcher.destroy();
  });

  test('drops batch after retryMaxAttempts and recovers to accept new events', async () => {
    const { scheduler } = fakeScheduler();
    let attempts = 0;
    const batcher = new Batcher({
      maxBatchSize: 1,
      flushInterval: 60_000,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      retryMaxAttempts: 3,
      scheduler,
      onFlush: async () => {
        attempts++;
        throw new Error('always fails');
      },
    });

    batcher.add(makeEvent(1));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(attempts).toBe(3);
    // After drop, a new add() should start a fresh retry cycle.
    attempts = 0;
    batcher.add(makeEvent(2));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(attempts).toBe(3);
    batcher.destroy();
  });

  test('succeeds on first try when onFlush resolves', async () => {
    const batcher = new Batcher({
      maxBatchSize: 1,
      flushInterval: 60_000,
      onFlush: async (events) => {
        expect(events.length).toBe(1);
      },
    });
    batcher.add(makeEvent(1));
    await Promise.resolve();
    batcher.destroy();
  });
});
