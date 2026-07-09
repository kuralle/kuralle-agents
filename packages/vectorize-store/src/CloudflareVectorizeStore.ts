/**
 * CloudflareVectorizeStore — VectorStore implementation for Cloudflare Vectorize.
 *
 * Uses the Cloudflare Vectorize binding API directly (available in Workers).
 * Zero npm dependencies. Designed for edge/serverless runtimes.
 *
 * Cloudflare Vectorize is a managed vector database accessible via
 * Workers bindings. It provides cosine, euclidean, and dot-product
 * similarity search with metadata filtering.
 *
 * Usage:
 * ```ts
 * // In your Worker's fetch handler:
 * const store = new CloudflareVectorizeStore({ binding: env.VECTORIZE_INDEX });
 * ```
 */

import type {
  VectorStoreCore,
  VectorEntry,
  VectorQueryParams,
  VectorQueryResult,
  IndexStats,
} from '@kuralle-agents/rag';
import { toCloudflareFilter } from '@kuralle-agents/rag/filters';

// ---------------------------------------------------------------------------
// Cloudflare Vectorize binding types (subset)
// ---------------------------------------------------------------------------

/**
 * Cloudflare Vectorize index binding. This interface matches the shape
 * exposed by `env.VECTORIZE_INDEX` in a Cloudflare Worker.
 */
export interface VectorizeBinding {
  insert(vectors: VectorizeVector[]): Promise<VectorizeMutationResult>;
  upsert(vectors: VectorizeVector[]): Promise<VectorizeMutationResult>;
  query(
    queryVector: number[],
    options?: VectorizeQueryOptions,
  ): Promise<VectorizeMatches>;
  getByIds(ids: string[]): Promise<VectorizeVector[]>;
  deleteByIds(ids: string[]): Promise<VectorizeMutationResult>;
  describe(): Promise<VectorizeIndexDetails>;
}

interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
  namespace?: string;
}

interface VectorizeQueryOptions {
  topK?: number;
  filter?: Record<string, unknown>;
  returnValues?: boolean;
  returnMetadata?: 'none' | 'indexed' | 'all';
  namespace?: string;
}

interface VectorizeMatch {
  id: string;
  score: number;
  values?: number[];
  metadata?: Record<string, string | number | boolean>;
}

interface VectorizeMatches {
  matches: VectorizeMatch[];
  count: number;
}

interface VectorizeMutationResult {
  count: number;
  ids: string[];
}

export interface VectorizeIndexDetails {
  vectorsCount: number;
  dimensions: number;
  config: {
    metric: string;
    dimensions: number;
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CloudflareVectorizeStoreOptions {
  /** The Vectorize index binding from the Worker environment. */
  binding: VectorizeBinding;
  /**
   * Namespace for multi-tenant isolation. When set, all operations
   * are scoped to this namespace.
   */
  namespace?: string;
}

// ---------------------------------------------------------------------------
// CloudflareVectorizeStore
// ---------------------------------------------------------------------------

/**
 * Cloudflare Vectorize implements `VectorStoreCore` only (REQ-17).
 * Indexes are provisioned via `wrangler.toml` / the Cloudflare dashboard
 * and cannot be created or deleted from within a Worker — so attempting
 * `createIndex` / `deleteIndex` / `deleteVectors` on a Vectorize store
 * is a typecheck error rather than a runtime silent no-op or warn.
 */
export class CloudflareVectorizeStore implements VectorStoreCore {
  private readonly binding: VectorizeBinding;
  private readonly namespace?: string;

  constructor(options: CloudflareVectorizeStoreOptions) {
    this.binding = options.binding;
    this.namespace = options.namespace;
  }

  async upsert(indexName: string, entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const vectors: VectorizeVector[] = entries.map(e => ({
      id: e.id,
      values: Array.from(e.vector),
      metadata: serializeMetadata(e.metadata),
      namespace: this.namespace,
    }));

    // Vectorize has a 1000-vector batch limit
    const BATCH_SIZE = 1000;
    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);
      await this.binding.upsert(batch);
    }
  }

  async query(
    indexName: string,
    params: VectorQueryParams,
  ): Promise<VectorQueryResult[]> {
    const options: VectorizeQueryOptions = {
      topK: params.topK ?? 10,
      returnValues: params.includeVectors ?? false,
      returnMetadata: 'all',
      namespace: this.namespace,
    };

    if (params.filter) {
      options.filter = toCloudflareFilter(params.filter);
    }

    const result = await this.binding.query(
      Array.from(params.queryVector),
      options,
    );

    return result.matches.map(m => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata as Record<string, unknown> | undefined,
      vector: m.values,
      // Vectorize doesn't store document text in metadata by default —
      // callers should include it in metadata under a 'document' key.
      document: params.includeDocuments !== false
        ? (m.metadata?.['_document'] as string | undefined)
        : undefined,
    }));
  }

  async listIndexes(): Promise<string[]> {
    // Vectorize binding represents a single index — return its implicit name.
    return ['default'];
  }

  async describeIndex(_indexName: string): Promise<IndexStats> {
    const details = await this.binding.describe();
    return {
      dimension: details.config.dimensions,
      count: details.vectorsCount,
      metric: normalizeMetric(details.config.metric),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeMetadata(
  metadata?: Record<string, unknown>,
): Record<string, string | number | boolean> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (value !== null && value !== undefined) {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}

function normalizeMetric(metric: string): 'cosine' | 'euclidean' | 'dotproduct' {
  const lower = metric.toLowerCase();
  if (lower === 'cosine') return 'cosine';
  if (lower === 'euclidean') return 'euclidean';
  if (lower === 'dot-product' || lower === 'dotproduct') return 'dotproduct';
  return 'cosine';
}
