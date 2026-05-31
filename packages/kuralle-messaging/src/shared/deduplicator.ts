/**
 * LRU-based message deduplication to prevent processing the same
 * webhook event twice. Uses a Map (which preserves insertion order)
 * as the underlying data structure with TTL-based expiration.
 */
export class MessageDeduplicator {
  private readonly cache: Map<string, number>;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  /**
   * Create a new deduplicator.
   * @param maxSize - Maximum number of message IDs to track. Default: 10000.
   * @param ttlMs - Time-to-live for entries in milliseconds. Default: 300000 (5 minutes).
   */
  constructor(maxSize = 10_000, ttlMs = 300_000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Check if a message ID has been seen recently.
   *
   * If the message ID is new, it is recorded and `false` is returned.
   * If it has been seen within the TTL window, `true` is returned.
   * Expired entries are treated as new.
   *
   * @param messageId - The platform-specific message identifier.
   * @returns `true` if this message was already processed (duplicate), `false` if new.
   */
  isDuplicate(messageId: string): boolean {
    const now = Date.now();
    const existing = this.cache.get(messageId);

    if (existing !== undefined) {
      // Check if the entry has expired
      if (now - existing < this.ttlMs) {
        return true;
      }
      // Expired — delete so we can re-insert at the end
      this.cache.delete(messageId);
    }

    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evict(now);
    }

    // Record this message
    this.cache.set(messageId, now);
    return false;
  }

  /**
   * Remove expired entries, then evict oldest if still at capacity.
   */
  private evict(now: number): void {
    // First pass: remove all expired entries
    for (const [key, timestamp] of this.cache) {
      if (now - timestamp >= this.ttlMs) {
        this.cache.delete(key);
      }
    }

    // If still at capacity, remove oldest entries (Map iterates in insertion order)
    if (this.cache.size >= this.maxSize) {
      const toRemove = this.cache.size - this.maxSize + 1;
      let removed = 0;
      for (const key of this.cache.keys()) {
        if (removed >= toRemove) break;
        this.cache.delete(key);
        removed++;
      }
    }
  }

  /** Return the current number of tracked message IDs. */
  get size(): number {
    return this.cache.size;
  }

  /** Clear all tracked message IDs. */
  clear(): void {
    this.cache.clear();
  }
}
