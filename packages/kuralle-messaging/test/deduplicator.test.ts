import { describe, it, expect } from 'bun:test';
import { MessageDeduplicator } from '../src/shared/deduplicator.js';

describe('MessageDeduplicator', () => {
  it('returns false (not duplicate) for the first call with a given ID', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.isDuplicate('msg-1')).toBe(false);
  });

  it('returns true (duplicate) for a second call with the same ID', () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate('msg-1');
    expect(dedup.isDuplicate('msg-1')).toBe(true);
  });

  it('returns false for different IDs', () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate('msg-1');
    expect(dedup.isDuplicate('msg-2')).toBe(false);
    expect(dedup.isDuplicate('msg-3')).toBe(false);
  });

  it('treats expired entries as new (not duplicate)', async () => {
    const dedup = new MessageDeduplicator(100, 50); // 50ms TTL
    dedup.isDuplicate('msg-1');
    expect(dedup.isDuplicate('msg-1')).toBe(true);

    // Wait for the entry to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // After expiry, should be treated as new
    expect(dedup.isDuplicate('msg-1')).toBe(false);
  });

  it('evicts oldest entries when maxSize is exceeded', () => {
    const dedup = new MessageDeduplicator(3, 300_000);

    dedup.isDuplicate('msg-1');
    dedup.isDuplicate('msg-2');
    dedup.isDuplicate('msg-3');
    expect(dedup.size).toBe(3);

    // Adding a 4th message should evict the oldest (msg-1)
    dedup.isDuplicate('msg-4');
    expect(dedup.size).toBeLessThanOrEqual(3);

    // msg-1 should have been evicted, so it is no longer a duplicate
    expect(dedup.isDuplicate('msg-1')).toBe(false);
  });

  it('size property reflects the current count', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.size).toBe(0);

    dedup.isDuplicate('a');
    expect(dedup.size).toBe(1);

    dedup.isDuplicate('b');
    expect(dedup.size).toBe(2);

    // Duplicate check should not increase size
    dedup.isDuplicate('a');
    expect(dedup.size).toBe(2);
  });

  it('clear() empties the cache', () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate('msg-1');
    dedup.isDuplicate('msg-2');
    expect(dedup.size).toBe(2);

    dedup.clear();
    expect(dedup.size).toBe(0);

    // Previously seen IDs should no longer be duplicates
    expect(dedup.isDuplicate('msg-1')).toBe(false);
  });

  it('evicts expired entries before oldest during capacity eviction', async () => {
    const dedup = new MessageDeduplicator(3, 50); // 50ms TTL, maxSize 3

    dedup.isDuplicate('old-1');
    dedup.isDuplicate('old-2');

    // Wait for first two to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    dedup.isDuplicate('new-1');
    expect(dedup.size).toBe(3); // old-1, old-2 still in map, new-1 added

    // Adding another should evict the expired entries first
    dedup.isDuplicate('new-2');

    // Expired entries should be gone
    expect(dedup.isDuplicate('old-1')).toBe(false);
    expect(dedup.isDuplicate('old-2')).toBe(false);
  });
});
