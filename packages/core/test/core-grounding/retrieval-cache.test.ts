import { describe, expect, it } from 'bun:test';
import { InMemoryRetrievalCache } from '../../src/runtime/InMemoryRetrievalCache.js';
import { buildKnowledgeProvider } from '../../src/runtime/grounding/index.js';
import type {
  KnowledgeRetrievalResult,
  KnowledgeRetrieverAdapter,
  KnowledgeEmbedderAdapter,
} from '../../src/types/knowledge.js';

const RESULT: KnowledgeRetrievalResult = {
  id: 'doc-1',
  text: "Acme's return window is 45 days.",
  sourceId: 'doc-1',
  score: 0.99,
  relevanceScore: 0.99,
};

/** Deterministic embedder: same text → same vector, different text → orthogonal-ish. */
function fakeEmbedder(): KnowledgeEmbedderAdapter {
  return {
    embed: async (text: string) => {
      // 4-dim bag: [len, vowels, spaces, first-char-code] — same string ⇒ identical vector.
      const vowels = (text.match(/[aeiou]/gi) ?? []).length;
      const spaces = (text.match(/ /g) ?? []).length;
      return [text.length, vowels, spaces, text.charCodeAt(0) || 0];
    },
  };
}

function countingRetriever(): { adapter: KnowledgeRetrieverAdapter; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    adapter: {
      retrieve: async () => {
        calls += 1;
        return [RESULT];
      },
    },
  };
}

describe('InMemoryRetrievalCache (G6)', () => {
  it('returns cached results for a sufficiently-similar query embedding', () => {
    const cache = new InMemoryRetrievalCache({ similarityThreshold: 0.85 });
    cache.populate([RESULT], [1, 0, 0, 0]);
    // Identical embedding → cosine 1.0 → hit.
    expect(cache.lookup([1, 0, 0, 0])).toEqual([RESULT]);
  });

  it('misses on a dissimilar query embedding', () => {
    const cache = new InMemoryRetrievalCache({ similarityThreshold: 0.85 });
    cache.populate([RESULT], [1, 0, 0, 0]);
    // Orthogonal embedding → cosine 0 → miss.
    expect(cache.lookup([0, 1, 0, 0])).toEqual([]);
  });

  it('respects topK on the returned slice', () => {
    const cache = new InMemoryRetrievalCache();
    const many = [RESULT, { ...RESULT, id: 'doc-2' }, { ...RESULT, id: 'doc-3' }];
    cache.populate(many, [1, 0, 0, 0]);
    expect(cache.lookup([1, 0, 0, 0], 2)).toHaveLength(2);
  });

  it('evicts the least-recently-used entry past maxEntries', () => {
    const cache = new InMemoryRetrievalCache({ maxEntries: 1, similarityThreshold: 0.99 });
    cache.populate([RESULT], [1, 0, 0, 0]);
    cache.populate([{ ...RESULT, id: 'doc-2' }], [0, 1, 0, 0]);
    expect(cache.size).toBe(1);
    expect(cache.lookup([1, 0, 0, 0])).toEqual([]); // first entry evicted
    expect(cache.lookup([0, 1, 0, 0])).toEqual([{ ...RESULT, id: 'doc-2' }]);
  });
});

describe('KnowledgeProvider session cache wiring (G6)', () => {
  it('defaults to an in-process cache when an embedder is present', () => {
    const { adapter } = countingRetriever();
    const provider = buildKnowledgeProvider({
      retriever: adapter,
      embedder: fakeEmbedder(),
      defaults: { topK: 3 },
    });
    expect(provider.createSessionCache()).toBeInstanceOf(InMemoryRetrievalCache);
  });

  it('has no cache when no embedder is configured (cache is embedding-keyed)', () => {
    const { adapter } = countingRetriever();
    const provider = buildKnowledgeProvider({ retriever: adapter, defaults: { topK: 3 } });
    expect(provider.createSessionCache()).toBeUndefined();
  });

  it('serves a repeat query from cache — retriever runs once, second turn is a cache hit', async () => {
    const { adapter, calls } = countingRetriever();
    const provider = buildKnowledgeProvider({
      retriever: adapter,
      embedder: fakeEmbedder(),
      defaults: { topK: 3 },
    });
    const cache = provider.createSessionCache();
    expect(cache).toBeDefined();

    const first = await provider.retrieve('return policy window', cache);
    const second = await provider.retrieve('return policy window', cache);

    expect(calls()).toBe(1); // retriever hit exactly once
    expect(second.results).toEqual(first.results);
    expect(second.events.some((e) => e.type === 'knowledge-cache-hit')).toBe(true);
    expect(first.events.some((e) => e.type === 'knowledge-cache-miss')).toBe(true);
  });
});
