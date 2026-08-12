/**
 * Per-key async mutex.
 *
 * SessionMutex serializes conversation-run turns and Session document mutations
 * (messages, working memory) for one sessionId.
 * RunMutex serializes steps within one flow run, keyed by runId.
 * Two keys run in parallel; the same key queues.
 *
 * The mutex uses a Map of per-key promise chains. When a key has no active lock,
 * the chain is empty and acquire() resolves immediately. When locked, acquire()
 * appends to the chain and waits.
 *
 * Locks are released in the `finally` block via the returned release
 * function, guaranteeing cleanup even on errors or aborts.
 */
export class KeyedMutex {
  /** Map of key to the tail of the promise chain. */
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire the lock for a key.
   *
   * If the key is not locked, resolves immediately.
   * If the key is locked, waits until the previous holder releases.
   *
   * @returns A release function that MUST be called when the critical section completes.
   */
  async acquire(key: string): Promise<() => void> {
    const currentTail = this.locks.get(key) ?? Promise.resolve();

    let releaseFn!: () => void;
    const newTail = new Promise<void>((resolve) => {
      releaseFn = () => {
        if (this.locks.get(key) === newTail) {
          this.locks.delete(key);
        }
        resolve();
      };
    });

    this.locks.set(key, newTail);

    await currentTail.catch(() => {});

    return releaseFn;
  }

  /** Number of keys currently locked. For testing/debugging. */
  get size(): number {
    return this.locks.size;
  }
}

export class SessionMutex extends KeyedMutex {}

export class RunMutex extends KeyedMutex {}
