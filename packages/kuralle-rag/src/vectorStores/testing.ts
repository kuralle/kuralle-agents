/// <reference types="bun-types" />
/**
 * Shared contract-test harness for every `VectorStore` adapter.
 *
 * Every vector-store adapter (InMemoryVectorStore, PgVectorStore,
 * LanceDbVectorStore, RedisVectorStore, UpstashVectorStore,
 * CloudflareVectorizeStore) MUST pass this contract. Adapters call
 * `runVectorStoreContract(() => new MyStore(...))` from within a `bun test`
 * test file.
 *
 * Capability-gated tests (index-admin operations) skip automatically on
 * stores that don't expose the relevant method — see Phase 3 REQ-16 split.
 *
 * This helper is NOT re-exported from the package's main barrel — import
 * explicitly from `@kuralle-agents/rag/vectorStores/testing`.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import type { VectorStoreCore, VectorEntry } from '../types.js';
import { hasIndexAdmin } from '../types.js';

export type VectorStoreFactory = () => VectorStoreCore | Promise<VectorStoreCore>;

const randomVector = (dim: number): number[] =>
  Array.from({ length: dim }, () => Math.random() - 0.5);

const makeEntries = (count: number, dim: number): VectorEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `v-${i}`,
    vector: randomVector(dim),
    metadata: { bucket: i % 2 === 0 ? 'even' : 'odd', i },
    document: `doc ${i}`,
  }));

/**
 * Registers the shared VectorStore contract tests. Must be invoked at the top
 * level of a bun test file.
 *
 * @param factory Called before each test; returns a fresh store instance.
 * @param options.indexName Name of the index the factory's store is configured
 *   for. Defaults to `'contract'`.
 * @param options.dimension Vector dimension. Defaults to `3` — low, to keep
 *   tests fast.
 * @param options.skipFilterTests Opt out of the metadata-filter test case.
 *   Set this for adapters whose filter translation is still on a pre-REQ-33
 *   path that doesn't yet match the canonical `rag/filters/` translators —
 *   track the fix in the adapter's issue.
 */
export function runVectorStoreContract(
  factory: VectorStoreFactory,
  options: { indexName?: string; dimension?: number; skipFilterTests?: boolean } = {},
): void {
  const indexName = options.indexName ?? 'contract';
  const dimension = options.dimension ?? 3;
  const skipFilterTests = options.skipFilterTests ?? false;

  describe('VectorStore contract', () => {
    let store: VectorStoreCore;

    beforeEach(async () => {
      store = await factory();
      if (hasIndexAdmin(store)) {
        try {
          await store.createIndex({ indexName, dimension, metric: 'cosine' });
        } catch {
          // May be idempotent on the backend; tolerate.
        }
      }
    });

    test('upsert then query returns matches', async () => {
      const entries = makeEntries(4, dimension);
      await store.upsert(indexName, entries);
      const results = await store.query(indexName, {
        queryVector: entries[0]!.vector,
        topK: 2,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(2);
      expect(typeof results[0]!.id).toBe('string');
      expect(typeof results[0]!.score).toBe('number');
    });

    test('query honors topK', async () => {
      const entries = makeEntries(6, dimension);
      await store.upsert(indexName, entries);
      const results = await store.query(indexName, {
        queryVector: entries[0]!.vector,
        topK: 3,
      });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    test('query with simple equality filter narrows results', async () => {
      if (skipFilterTests) return;
      const entries = makeEntries(6, dimension);
      await store.upsert(indexName, entries);
      const results = await store.query(indexName, {
        queryVector: entries[0]!.vector,
        topK: 10,
        filter: { bucket: 'even' },
      });
      for (const r of results) {
        if (r.metadata) {
          expect(r.metadata.bucket).toBe('even');
        }
      }
    });

    test('listIndexes returns an array', async () => {
      const indexes = await store.listIndexes();
      expect(Array.isArray(indexes)).toBe(true);
    });

    test('describeIndex returns shape', async () => {
      const stats = await store.describeIndex(indexName);
      expect(typeof stats.count).toBe('number');
      expect(typeof stats.dimension).toBe('number');
    });

    test('deleteVectors by ids (admin-gated)', async () => {
      if (!hasIndexAdmin(store)) return;
      const entries = makeEntries(3, dimension);
      await store.upsert(indexName, entries);
      await store.deleteVectors(indexName, { ids: [entries[0]!.id] });
      const results = await store.query(indexName, {
        queryVector: entries[0]!.vector,
        topK: 10,
      });
      const remainingIds = results.map(r => r.id);
      expect(remainingIds).not.toContain(entries[0]!.id);
    });

    test('deleteIndex (admin-gated)', async () => {
      if (!hasIndexAdmin(store)) return;
      await store.deleteIndex(indexName);
    });
  });
}
