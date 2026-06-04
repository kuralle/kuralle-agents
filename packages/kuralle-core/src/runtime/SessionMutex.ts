/**
 * Per-session async mutex.
 *
 * Serializes concurrent `stream()` calls for the same sessionId.
 * Two concurrent turns for different sessionIds run in parallel.
 * Two concurrent turns for the SAME sessionId are queued — the second
 * waits for the first to complete before starting.
 *
 * This prevents the read-modify-write race on session state that
 * occurs when two requests arrive for the same session simultaneously
 * (user double-tap, webhook retry, mid-stream takeover).
 *
 * The mutex uses a Map of per-session promise chains. When a session
 * has no active lock, the chain is empty and acquire() resolves
 * immediately. When locked, acquire() appends to the chain and waits.
 *
 * Locks are released in the `finally` block via the returned release
 * function, guaranteeing cleanup even on errors or aborts.
 */
export class SessionMutex {
  /** Map of sessionId to the tail of the promise chain. */
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire the lock for a session.
   *
   * If the session is not locked, resolves immediately.
   * If the session is locked by another turn, waits until the
   * previous turn releases.
   *
   * @param sessionId - The session to lock.
   * @returns A release function that MUST be called when the turn completes.
   */
  async acquire(sessionId: string): Promise<() => void> {
    // Get the current tail of the chain (or a resolved promise if unlocked)
    const currentTail = this.locks.get(sessionId) ?? Promise.resolve();

    // Create a new promise that the NEXT waiter will await
    let releaseFn!: () => void;
    const newTail = new Promise<void>((resolve) => {
      releaseFn = () => {
        // Clean up the map entry if this is the last in the chain
        if (this.locks.get(sessionId) === newTail) {
          this.locks.delete(sessionId);
        }
        resolve();
      };
    });

    // Set the new tail BEFORE awaiting — so the next concurrent caller
    // sees this promise in the chain
    this.locks.set(sessionId, newTail);

    await currentTail.catch(() => {});

    return releaseFn;
  }

  /** Number of sessions currently locked. For testing/debugging. */
  get size(): number {
    return this.locks.size;
  }
}
