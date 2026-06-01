export interface BroadcastLedger {
  /** Atomic compare-and-set. Returns true if newly added, false if the key already existed. */
  putIfAbsent(key: string): Promise<boolean>;
}

export function createInMemoryBroadcastLedger(): BroadcastLedger {
  const seen = new Set<string>();
  return {
    async putIfAbsent(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}
