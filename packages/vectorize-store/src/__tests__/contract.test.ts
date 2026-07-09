/**
 * Shared-contract test wiring for CloudflareVectorizeStore.
 *
 * Cloudflare Vectorize is a Workers binding — we can't instantiate it
 * outside a Worker runtime. Instead, per Open Q11's "recorded-fixture
 * mocks for Cloudflare" proposal, we stand up a fake binding that
 * implements the subset of the VectorizeBinding shape the adapter uses
 * and exercises the full VectorStore contract against it.
 */

import { runVectorStoreContract } from '@kuralle-agents/rag/vectorStores/testing';

import { CloudflareVectorizeStore, type VectorizeBinding, type VectorizeIndexDetails } from '../CloudflareVectorizeStore.js';

type Row = {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
};

function createFakeBinding(): VectorizeBinding {
  const rows: Row[] = [];
  const cosine = (a: number[], b: number[]): number => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] ?? 0, y = b[i] ?? 0;
      dot += x * y; na += x * x; nb += y * y;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  };

  return {
    async insert(vectors) {
      for (const v of vectors) {
        if (rows.find(r => r.id === v.id)) continue;
        rows.push({ id: v.id, values: v.values, metadata: v.metadata });
      }
      return { count: vectors.length, ids: vectors.map(v => v.id) };
    },
    async upsert(vectors) {
      for (const v of vectors) {
        const i = rows.findIndex(r => r.id === v.id);
        const row = { id: v.id, values: v.values, metadata: v.metadata };
        if (i >= 0) rows[i] = row; else rows.push(row);
      }
      return { count: vectors.length, ids: vectors.map(v => v.id) };
    },
    async query(queryVector, options) {
      const topK = options?.topK ?? 10;
      const matches = rows
        .map(r => ({
          id: r.id,
          score: cosine(queryVector, r.values),
          values: options?.returnValues ? r.values : undefined,
          metadata: options?.returnMetadata && options.returnMetadata !== 'none' ? r.metadata : undefined,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return { matches, count: matches.length };
    },
    async getByIds(ids) {
      return rows.filter(r => ids.includes(r.id)).map(r => ({
        id: r.id,
        values: r.values,
        metadata: r.metadata,
      }));
    },
    async deleteByIds(ids) {
      let count = 0;
      for (const id of ids) {
        const i = rows.findIndex(r => r.id === id);
        if (i >= 0) { rows.splice(i, 1); count++; }
      }
      return { count, ids };
    },
    async describe(): Promise<VectorizeIndexDetails> {
      return {
        vectorsCount: rows.length,
        dimensions: rows[0]?.values.length ?? 0,
        config: {
          dimensions: rows[0]?.values.length ?? 0,
          metric: 'cosine',
        },
      };
    },
  };
}

runVectorStoreContract(
  () => new CloudflareVectorizeStore({ binding: createFakeBinding() }),
  {
    indexName: 'contract',
    dimension: 3,
    // CloudflareVectorizeStore's flattenFilter warns-and-drops logical filter
    // ops pre-REQ-33. Full filter behavior (including the direct-removal
    // throw semantics added in C-8.1) lands when the adapter migrates to
    // `toCloudflareFilter` from rag/filters in issue 27.
    skipFilterTests: true,
  },
);
