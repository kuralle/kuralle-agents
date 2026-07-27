import { describe, expect, it } from 'bun:test';
import { promptCacheKeyFor } from '../../src/runtime/promptCache.js';
import type { SystemModelMessage } from 'ai';

/**
 * OpenAI's `prompt_cache_key` is a routing hint: requests sharing a key route to the same
 * cache. Keying it on `sessionId` gave every session its own lane, so two users talking to
 * the SAME agent — identical instructions, identical tools, therefore an identical cacheable
 * prefix — could never share a cache entry. The stable head is exactly the part that is
 * common across sessions, so it is what the key should be derived from.
 */
const head = (content: string): SystemModelMessage[] => [{ role: 'system', content }];

describe('promptCacheKeyFor', () => {
  it('is identical for two sessions with the same prefix', () => {
    const a = promptCacheKeyFor(head('You are Realm.'), { alpha: {}, beta: {} } as never);
    const b = promptCacheKeyFor(head('You are Realm.'), { alpha: {}, beta: {} } as never);
    expect(a).toBe(b);
  });

  it('differs when the stable instructions differ', () => {
    const a = promptCacheKeyFor(head('You are Realm.'), {} as never);
    const b = promptCacheKeyFor(head('You are Atlas.'), {} as never);
    expect(a).not.toBe(b);
  });

  it('differs when the tool surface differs', () => {
    const a = promptCacheKeyFor(head('same'), { alpha: {} } as never);
    const b = promptCacheKeyFor(head('same'), { alpha: {}, beta: {} } as never);
    expect(a).not.toBe(b);
  });

  it('ignores tool declaration order — the same surface is the same prefix', () => {
    const a = promptCacheKeyFor(head('same'), { alpha: {}, beta: {} } as never);
    const b = promptCacheKeyFor(head('same'), { beta: {}, alpha: {} } as never);
    expect(a).toBe(b);
  });
});
