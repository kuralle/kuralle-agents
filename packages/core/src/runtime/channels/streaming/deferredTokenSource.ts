import type { TokenSource } from './speakGated.js';

export type DeferredCloseReason = 'complete' | 'interrupted' | 'error';

export interface DeferredTokenSource {
  source: TokenSource;
  push(delta: string): void;
  close(reason?: DeferredCloseReason): void;
}

export function createDeferredTokenSource(): DeferredTokenSource {
  const queue: { delta: string }[] = [];
  let closed = false;
  let closeReason: DeferredCloseReason | undefined;
  const waiters: Array<() => void> = [];

  const notify = (): void => {
    for (const wake of waiters) wake();
    waiters.length = 0;
  };

  const source: TokenSource = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (closed) {
          if (closeReason === 'interrupted') {
            throw new Error('interrupted');
          }
          return;
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
  };

  return {
    source,
    push(delta: string): void {
      if (closed || delta.length === 0) return;
      queue.push({ delta });
      notify();
    },
    close(reason: DeferredCloseReason = 'complete'): void {
      if (closed) return;
      closed = true;
      closeReason = reason;
      notify();
    },
  };
}
