import { describe, expect, it } from 'bun:test';
import { createInputCoalescer } from '../src/adapter/input-coalescer.js';
import type { InputCoalescerTimer } from '../src/adapter/input-coalescer.js';

interface Scheduled {
  fn: () => void;
  at: number;
  id: number;
}

function createTestTimer() {
  let now = 0;
  let nextId = 0;
  const scheduled: Scheduled[] = [];
  const cancelled = new Set<number>();

  const timer: InputCoalescerTimer = {
    set(fn, ms) {
      const id = nextId++;
      scheduled.push({ fn, at: now + ms, id });
      return id;
    },
    clear(handle) {
      cancelled.add(handle as number);
    },
  };

  function advance(ms: number) {
    now += ms;
    const due = scheduled
      .filter((s) => !cancelled.has(s.id) && s.at <= now)
      .sort((a, b) => a.at - b.at);
    for (const s of due) {
      cancelled.add(s.id);
      s.fn();
    }
  }

  return { timer, advance, now: () => now };
}

describe('createInputCoalescer', () => {
  it('passes through immediately when debounceMs is 0', () => {
    const deliveries: number[][] = [];
    const coalescer = createInputCoalescer<number>({ debounceMs: 0 });
    coalescer.push('t1', 1, (items) => {
      deliveries.push(items);
    });
    coalescer.push('t1', 2, (items) => {
      deliveries.push(items);
    });
    expect(deliveries).toEqual([[1], [2]]);
  });

  it('resets sliding debounce on each new message', () => {
    const { timer, advance } = createTestTimer();
    const deliveries: number[][] = [];
    const coalescer = createInputCoalescer<number>({
      debounceMs: 100,
      maxWaitMs: 10_000,
      timer,
    });

    coalescer.push('t1', 1, (items) => {
      deliveries.push(items);
    });
    advance(80);
    coalescer.push('t1', 2, (items) => {
      deliveries.push(items);
    });
    advance(80);
    expect(deliveries).toEqual([]);
    advance(25);
    expect(deliveries).toEqual([[1, 2]]);
  });

  it('flushes at maxWaitMs even if the user keeps typing', () => {
    const { timer, advance } = createTestTimer();
    const deliveries: number[][] = [];
    const coalescer = createInputCoalescer<number>({
      debounceMs: 500,
      maxWaitMs: 1000,
      timer,
    });

    coalescer.push('t1', 1, (items) => {
      deliveries.push(items);
    });
    advance(400);
    coalescer.push('t1', 2, (items) => {
      deliveries.push(items);
    });
    advance(400);
    coalescer.push('t1', 3, (items) => {
      deliveries.push(items);
    });
    advance(250);
    expect(deliveries).toEqual([[1, 2, 3]]);
  });

  it('flushes when maxMessages is reached', () => {
    const { timer, advance } = createTestTimer();
    const deliveries: number[][] = [];
    const coalescer = createInputCoalescer<number>({
      debounceMs: 5000,
      maxWaitMs: 10_000,
      maxMessages: 3,
      timer,
    });

    coalescer.push('t1', 1, (items) => {
      deliveries.push(items);
    });
    coalescer.push('t1', 2, (items) => {
      deliveries.push(items);
    });
    coalescer.push('t1', 3, (items) => {
      deliveries.push(items);
    });
    expect(deliveries).toEqual([[1, 2, 3]]);
    advance(5000);
    expect(deliveries).toEqual([[1, 2, 3]]);
  });

  it('flushImmediately merges buffered items and bypasses debounce', () => {
    const { timer, advance } = createTestTimer();
    const deliveries: number[][] = [];
    const coalescer = createInputCoalescer<{ n: number; urgent?: boolean }>({
      debounceMs: 500,
      maxWaitMs: 10_000,
      timer,
      flushImmediately: (item) => item.urgent === true,
    });

    coalescer.push('t1', { n: 1 }, (items) => {
      deliveries.push(items.map((i) => i.n));
    });
    advance(100);
    coalescer.push('t1', { n: 2, urgent: true }, (items) => {
      deliveries.push(items.map((i) => i.n));
    });
    expect(deliveries).toEqual([[1, 2]]);
    advance(500);
    expect(deliveries).toEqual([[1, 2]]);
  });

  it('isolates buffers per thread', () => {
    const { timer, advance } = createTestTimer();
    const deliveries: Array<{ thread: string; items: number[] }> = [];
    const coalescer = createInputCoalescer<number>({
      debounceMs: 100,
      maxWaitMs: 10_000,
      timer,
    });

    coalescer.push('a', 1, (items) => {
      deliveries.push({ thread: 'a', items });
    });
    coalescer.push('b', 9, (items) => {
      deliveries.push({ thread: 'b', items });
    });
    advance(100);
    expect(deliveries).toEqual([
      { thread: 'a', items: [1] },
      { thread: 'b', items: [9] },
    ]);
  });
});
