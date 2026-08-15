import { describe, it, expect } from 'bun:test';

import { createTurnHandle, createEventBus } from '../src/events/TurnHandle.ts';
import type { TurnResult } from '../src/types/channel.ts';

/**
 * A `TurnHandle` is both a promise and an event source, and a failing turn delivers its error
 * down both paths. Consumers that only stream never touch the promise half, so its rejection
 * used to land with no handler attached — an `unhandledRejection` that terminates the process.
 * One bad provider call would take down a server for every session on it.
 *
 * These tests pin both halves of the contract, because the obvious fix breaks the second one:
 * swallowing the rejection outright would stop the crash and also stop `await runtime.run(...)`
 * from ever seeing an error.
 */
function failingHandle(error: Error) {
  const bus = createEventBus();
  return createTurnHandle({
    run: () => Promise.reject(error),
    bus,
  });
}

describe('createTurnHandle — a stream-only consumer must not crash the process', () => {
  it('does not raise unhandledRejection when only the event side is consumed', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const handle = failingHandle(new Error('provider exploded'));

      // Exactly what a streaming server does: read events, never await the handle.
      for await (const _part of handle.events) {
        void _part;
      }

      // Rejections are reported on a later microtask/tick than the one that rejected, so give
      // the runtime a real chance to fire the event before asserting it did not.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('still rejects for a caller that awaits it', async () => {
    const handle = failingHandle(new Error('provider exploded'));
    await expect(handle).rejects.toThrow('provider exploded');
  });

  it('still rejects handle.runId for a caller that awaits it', async () => {
    const handle = failingHandle(new Error('provider exploded'));
    await expect(handle.runId).rejects.toThrow('provider exploded');
  });

  it('still resolves the turn result for a caller that awaits a successful turn', async () => {
    const bus = createEventBus();
    const result = { output: 'ok' } as unknown as TurnResult;
    const handle = createTurnHandle({ run: () => Promise.resolve(result), bus });
    await expect(handle).resolves.toBe(result);
  });
});
