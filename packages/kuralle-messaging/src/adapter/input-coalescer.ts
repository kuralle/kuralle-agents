import type { InjectableTimer } from '@kuralle-agents/core';

export type InputCoalescerTimer = InjectableTimer;

const defaultTimer: InputCoalescerTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface InputCoalescerOptions<T> {
  debounceMs?: number;
  maxWaitMs?: number;
  maxMessages?: number;
  flushImmediately?: (item: T) => boolean;
  timer?: InputCoalescerTimer;
}

export interface InputCoalescer<T> {
  push(threadId: string, item: T, deliver: (items: T[]) => void | Promise<void>): void;
  flush(threadId: string): void;
}

interface ThreadBuffer<T> {
  items: T[];
  firstAt: number;
  debounceHandle: unknown;
  maxWaitHandle: unknown;
  deliver: (items: T[]) => void | Promise<void>;
}

export function createInputCoalescer<T>(opts: InputCoalescerOptions<T> = {}): InputCoalescer<T> {
  const debounceMs = opts.debounceMs ?? 3000;
  const maxWaitMs = opts.maxWaitMs ?? 10000;
  const maxMessages = opts.maxMessages ?? 10;
  const flushImmediately = opts.flushImmediately ?? (() => false);
  const timer = opts.timer ?? defaultTimer;
  const buffers = new Map<string, ThreadBuffer<T>>();

  function clearTimers(buf: ThreadBuffer<T>): void {
    if (buf.debounceHandle != null) timer.clear(buf.debounceHandle);
    if (buf.maxWaitHandle != null) timer.clear(buf.maxWaitHandle);
    buf.debounceHandle = undefined;
    buf.maxWaitHandle = undefined;
  }

  // Delivery runs a full agent turn — invoke synchronously (tests and router
  // ordering rely on it) but never let a sync throw or async rejection escape.
  function safeDeliver(
    deliver: (items: T[]) => void | Promise<void>,
    items: T[],
  ): void {
    try {
      const result = deliver(items);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch((error) => {
          console.warn('[Kuralle] coalesced inbound delivery failed:', error);
        });
      }
    } catch (error) {
      console.warn('[Kuralle] coalesced inbound delivery failed:', error);
    }
  }

  function invokeDeliver(buf: ThreadBuffer<T>): void {
    safeDeliver(buf.deliver, buf.items);
  }

  function flush(threadId: string): void {
    const buf = buffers.get(threadId);
    if (!buf || buf.items.length === 0) return;
    clearTimers(buf);
    buffers.delete(threadId);
    invokeDeliver(buf);
  }

  function push(
    threadId: string,
    item: T,
    deliver: (items: T[]) => void | Promise<void>,
  ): void {
    if (debounceMs === 0) {
      safeDeliver(deliver, [item]);
      return;
    }

    if (flushImmediately(item)) {
      const buf = buffers.get(threadId);
      const batch = buf ? [...buf.items, item] : [item];
      if (buf) {
        clearTimers(buf);
        buffers.delete(threadId);
      }
      safeDeliver(deliver, batch);
      return;
    }

    let buf = buffers.get(threadId);
    if (!buf) {
      buf = {
        items: [],
        firstAt: Date.now(),
        debounceHandle: undefined,
        maxWaitHandle: undefined,
        deliver,
      };
      buffers.set(threadId, buf);
      buf.maxWaitHandle = timer.set(() => flush(threadId), maxWaitMs);
    } else {
      buf.deliver = deliver;
    }

    buf.items.push(item);

    if (buf.items.length >= maxMessages) {
      flush(threadId);
      return;
    }

    if (buf.debounceHandle != null) timer.clear(buf.debounceHandle);
    buf.debounceHandle = timer.set(() => flush(threadId), debounceMs);
  }

  return { push, flush };
}
