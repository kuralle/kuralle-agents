import { describe, it, expect } from 'bun:test';
import {
  createInProcessScheduler,
  type InjectableTimer,
  type SendJob,
} from '../src/scheduler.js';

function createManualTimer(): {
  timer: InjectableTimer;
  fireAll(): void;
  pendingCount(): number;
} {
  const pending = new Map<unknown, () => void>();
  let nextHandle = 0;

  return {
    timer: {
      set(fn, _ms) {
        const handle = ++nextHandle;
        pending.set(handle, fn);
        return handle;
      },
      clear(handle) {
        pending.delete(handle);
      },
    },
    fireAll() {
      for (const fn of pending.values()) {
        fn();
      }
      pending.clear();
    },
    pendingCount() {
      return pending.size;
    },
  };
}

describe('createInProcessScheduler', () => {
  it('scheduler_enqueue_fires', async () => {
    const manual = createManualTimer();
    const ran: SendJob[] = [];
    const scheduler = createInProcessScheduler({
      run: (job) => {
        ran.push(job);
      },
      timer: manual.timer,
    });

    const job: SendJob = { kind: 'drip-step', payload: { step: 1 } };
    const jobId = await scheduler.enqueue(job, { delayMs: 100 });
    expect(jobId).toBe('1');
    expect(ran).toHaveLength(0);
    expect(manual.pendingCount()).toBe(1);

    manual.fireAll();
    expect(ran).toEqual([job]);
  });

  it('scheduler_cancel_prevents', async () => {
    const manual = createManualTimer();
    let runCount = 0;
    const scheduler = createInProcessScheduler({
      run: () => {
        runCount++;
      },
      timer: manual.timer,
    });

    const jobId = await scheduler.enqueue({ kind: 'broadcast', payload: {} });
    await scheduler.cancel(jobId);
    expect(manual.pendingCount()).toBe(0);

    manual.fireAll();
    expect(runCount).toBe(0);
  });

  it('returns deterministic incrementing job ids', async () => {
    const manual = createManualTimer();
    const scheduler = createInProcessScheduler({
      run: () => {},
      timer: manual.timer,
    });

    expect(await scheduler.enqueue({ kind: 'a', payload: {} })).toBe('1');
    expect(await scheduler.enqueue({ kind: 'b', payload: {} })).toBe('2');
    expect(await scheduler.enqueue({ kind: 'c', payload: {} })).toBe('3');
  });
});
