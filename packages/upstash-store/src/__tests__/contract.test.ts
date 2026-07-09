/**
 * Shared-contract test wiring for UpstashVectorStore.
 *
 * Upstash's REST API can't be stood up locally — instead, `global.fetch`
 * is intercepted with a recorded-fixture mock that emulates the handful
 * of endpoints the contract exercises (/upsert, /query, /info, /reset,
 * /delete). This matches Open Q11's "recorded-fixture mocks for Upstash"
 * proposal in 05-security-rollback-open-qs.md.
 *
 * The mock models Upstash's behavior for cosine similarity in the tiny
 * dimension (3) the helper uses: score = dot product / (|a| * |b|).
 */

import { beforeEach, afterEach } from 'bun:test';

import { runVectorStoreContract } from '@kuralle-agents/rag/vectorStores/testing';

import { UpstashVectorStore } from '../UpstashVectorStore.js';

type Stored = { id: string; vector: number[]; metadata?: Record<string, unknown>; data?: string };

const store: Stored[] = [];
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  store.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    const respond = (result: unknown, status = 200): Response =>
      new Response(JSON.stringify({ result }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (path === '/upsert' && method === 'POST') {
      for (const v of body as Stored[]) {
        const i = store.findIndex(x => x.id === v.id);
        if (i >= 0) store[i] = v; else store.push(v);
      }
      return Promise.resolve(respond('Success'));
    }

    if (path === '/query' && method === 'POST') {
      const q = body as { vector: number[]; topK?: number; includeMetadata?: boolean; includeData?: boolean };
      const scored = store
        .map(s => ({ ...s, score: cosine(q.vector, s.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, q.topK ?? 10)
        .map(s => ({
          id: s.id,
          score: s.score,
          ...(q.includeMetadata ? { metadata: s.metadata } : {}),
          ...(q.includeData && s.data ? { data: s.data } : {}),
        }));
      return Promise.resolve(respond(scored));
    }

    if (path === '/info' && method === 'GET') {
      return Promise.resolve(respond({
        vectorCount: store.length,
        dimension: store[0]?.vector.length ?? 0,
        similarityFunction: 'COSINE',
      }));
    }

    if (path === '/reset' && method === 'POST') {
      store.length = 0;
      return Promise.resolve(respond('Success'));
    }

    if (path === '/delete' && (method === 'DELETE' || method === 'POST')) {
      if (Array.isArray(body)) {
        for (const id of body as string[]) {
          const i = store.findIndex(s => s.id === id);
          if (i >= 0) store.splice(i, 1);
        }
      }
      return Promise.resolve(respond({ deleted: 1 }));
    }

    return Promise.resolve(respond(null, 404));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

runVectorStoreContract(
  () => new UpstashVectorStore({ url: 'https://test.upstash.io', token: 'fake-token' }),
  {
    indexName: 'contract',
    dimension: 3,
    // Upstash accepts SQL-like filter strings via the filter parameter — the
    // REST endpoint applies them server-side. Our mock doesn't reproduce that
    // translation, so the filter test is opted out.
    skipFilterTests: true,
  },
);
