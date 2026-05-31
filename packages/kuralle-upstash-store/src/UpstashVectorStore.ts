/**
 * UpstashVectorStore — VectorStore implementation for Upstash Vector.
 *
 * Uses the Upstash Vector REST API via `fetch()`. Zero npm dependencies.
 * Designed for edge/serverless runtimes (Cloudflare Workers, Vercel Edge,
 * Deno Deploy, AWS Lambda@Edge).
 *
 * Upstash Vector is a serverless vector database with a REST API.
 * It supports cosine, euclidean, and dot-product similarity, with
 * metadata filtering.
 */

import type {
  VectorStoreCore,
  VectorEntry,
  VectorQueryParams,
  VectorQueryResult,
  IndexStats,
} from '@kuralle-agents/rag';
import { toUpstashFilterString } from '@kuralle-agents/rag/filters';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface UpstashVectorStoreOptions {
  /** Upstash Vector REST URL (e.g., https://xxx-us1-vector.upstash.io). */
  url: string;
  /**
   * Upstash Vector token. If not provided, reads from UPSTASH_VECTOR_REST_TOKEN
   * environment variable at call time.
   */
  token?: string;
}

// ---------------------------------------------------------------------------
// Upstash API response types (subset)
// ---------------------------------------------------------------------------

interface UpstashUpsertVector {
  id: string;
  vector: number[];
  metadata?: Record<string, unknown>;
  data?: string;
}

interface UpstashQueryResult {
  id: string;
  score: number;
  vector?: number[];
  metadata?: Record<string, unknown>;
  data?: string;
}

interface UpstashInfoResult {
  vectorCount: number;
  dimension: number;
  similarityFunction: string;
}

// ---------------------------------------------------------------------------
// UpstashVectorStore
// ---------------------------------------------------------------------------

/**
 * Upstash Vector implements `VectorStoreCore` only (REQ-17). Indexes are
 * provisioned out-of-band via the Upstash dashboard, so attempting
 * `createIndex` / `deleteIndex` / filter-based `deleteVectors` on an
 * Upstash store is a typecheck error rather than a runtime silent
 * no-op.
 */
export class UpstashVectorStore implements VectorStoreCore {
  private readonly url: string;
  private readonly token?: string;

  constructor(options: UpstashVectorStoreOptions) {
    this.url = options.url.replace(/\/$/, '');
    this.token = options.token;
  }

  async upsert(_indexName: string, entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const vectors: UpstashUpsertVector[] = entries.map(e => ({
      id: e.id,
      vector: Array.from(e.vector),
      metadata: e.metadata,
      data: e.document,
    }));

    // Upstash accepts up to 1000 vectors per request
    const BATCH_SIZE = 1000;
    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);
      await this.request('POST', '/upsert', batch);
    }
  }

  async query(
    _indexName: string,
    params: VectorQueryParams,
  ): Promise<VectorQueryResult[]> {
    const body: Record<string, unknown> = {
      vector: Array.from(params.queryVector),
      topK: params.topK ?? 10,
      includeVectors: params.includeVectors ?? false,
      includeMetadata: true,
      includeData: params.includeDocuments !== false,
    };

    if (params.filter) {
      body.filter = toUpstashFilterString(params.filter);
    }

    const results = await this.request<UpstashQueryResult[]>(
      'POST',
      '/query',
      body,
    );

    return (results ?? []).map(r => ({
      id: r.id,
      score: r.score,
      metadata: r.metadata,
      vector: r.vector,
      document: r.data,
    }));
  }

  async listIndexes(): Promise<string[]> {
    // Single-index per Upstash database
    return ['default'];
  }

  async describeIndex(_indexName: string): Promise<IndexStats> {
    const info = await this.request<UpstashInfoResult>('GET', '/info');
    if (!info) {
      return { dimension: 0, count: 0, metric: 'cosine' };
    }
    return {
      dimension: info.dimension,
      count: info.vectorCount,
      metric: normalizeMetric(info.similarityFunction),
    };
  }

  // -------------------------------------------------------------------------
  // HTTP client
  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | undefined> {
    const token = this.resolveToken();
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(
        `UpstashVectorStore: API error (${response.status}): ${errorBody}`,
      );
    }

    const json = await response.json() as { result?: T };
    return json.result;
  }

  private resolveToken(): string {
    const token = this.token ?? (typeof process !== 'undefined'
      ? process.env?.UPSTASH_VECTOR_REST_TOKEN
      : undefined);
    if (!token) {
      throw new Error(
        'UpstashVectorStore: No token provided. Pass token in options ' +
        'or set the UPSTASH_VECTOR_REST_TOKEN environment variable.',
      );
    }
    return token;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeMetric(metric: string): 'cosine' | 'euclidean' | 'dotproduct' {
  const lower = metric.toLowerCase();
  if (lower === 'cosine') return 'cosine';
  if (lower === 'euclidean') return 'euclidean';
  if (lower.includes('dot')) return 'dotproduct';
  return 'cosine';
}
