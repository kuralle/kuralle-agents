import type {
  VectorStoreCore,
  VectorStoreIndexAdmin,
  VectorEntry,
  VectorQueryParams,
  VectorQueryResult,
  CreateIndexParams,
  IndexStats,
  VectorFilter,
} from '../types.js';
import { matchFilter } from '../filters/matcher.js';

interface IndexData {
  dimension: number;
  metric: 'cosine' | 'euclidean' | 'dotproduct';
  entries: Map<string, VectorEntry & { document?: string }>;
}

/**
 * In-memory vector store for development and testing.
 * Uses brute-force similarity search (O(n) per query).
 * Not suitable for production workloads.
 */
export class InMemoryVectorStore implements VectorStoreCore, VectorStoreIndexAdmin {
  private indexes = new Map<string, IndexData>();

  async createIndex(params: CreateIndexParams): Promise<void> {
    if (this.indexes.has(params.indexName)) return;
    this.indexes.set(params.indexName, {
      dimension: params.dimension,
      metric: params.metric ?? 'cosine',
      entries: new Map(),
    });
  }

  async upsert(indexName: string, entries: VectorEntry[]): Promise<void> {
    const index = this.getIndex(indexName);
    for (const entry of entries) {
      if (entry.vector.length !== index.dimension) {
        throw new Error(
          `Vector dimension mismatch: expected ${index.dimension}, ` +
          `got ${entry.vector.length} for entry "${entry.id}"`,
        );
      }
      index.entries.set(entry.id, { ...entry });
    }
  }

  async listEntries(
    indexName: string,
    params?: { filter?: VectorFilter },
  ): Promise<
    Array<{ id: string; metadata?: Record<string, unknown>; document?: string }>
  > {
    const index = this.getIndex(indexName);
    const out: Array<{
      id: string;
      metadata?: Record<string, unknown>;
      document?: string;
    }> = [];
    for (const [id, entry] of index.entries) {
      if (params?.filter && !matchFilter(entry.metadata ?? {}, params.filter)) {
        continue;
      }
      out.push({ id, metadata: entry.metadata, document: entry.document });
    }
    return out;
  }

  async query(
    indexName: string,
    params: VectorQueryParams,
  ): Promise<VectorQueryResult[]> {
    const index = this.getIndex(indexName);
    const topK = params.topK ?? 10;
    const scored: VectorQueryResult[] = [];

    for (const [id, entry] of index.entries) {
      if (params.filter && !matchFilter(entry.metadata ?? {}, params.filter)) {
        continue;
      }
      const score = computeSimilarity(
        params.queryVector,
        entry.vector,
        index.metric,
      );
      scored.push({
        id,
        score,
        metadata: entry.metadata,
        document: params.includeDocuments !== false ? entry.document : undefined,
        vector: params.includeVectors ? [...entry.vector] : undefined,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async listIndexes(): Promise<string[]> {
    return Array.from(this.indexes.keys());
  }

  async deleteIndex(indexName: string): Promise<void> {
    this.indexes.delete(indexName);
  }

  async deleteVectors(
    indexName: string,
    params: { ids?: string[]; filter?: VectorFilter },
  ): Promise<void> {
    const index = this.getIndex(indexName);
    if (params.ids) {
      for (const id of params.ids) {
        index.entries.delete(id);
      }
    }
    if (params.filter) {
      for (const [id, entry] of index.entries) {
        if (matchFilter(entry.metadata ?? {}, params.filter)) {
          index.entries.delete(id);
        }
      }
    }
  }

  async describeIndex(indexName: string): Promise<IndexStats> {
    const index = this.getIndex(indexName);
    return {
      dimension: index.dimension,
      count: index.entries.size,
      metric: index.metric,
    };
  }

  private getIndex(name: string): IndexData {
    const index = this.indexes.get(name);
    if (!index) throw new Error(`Index "${name}" does not exist.`);
    return index;
  }
}

// -- Similarity computation -------------------------------------------------

function computeSimilarity(
  a: readonly number[],
  b: readonly number[],
  metric: string,
): number {
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }
  if (metric === 'dotproduct') return dotProduct;
  if (metric === 'euclidean') {
    let sumSqDiff = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sumSqDiff += diff * diff;
    }
    return 1 / (1 + Math.sqrt(sumSqDiff));
  }
  // cosine
  const magA = Math.sqrt(magnitudeA);
  const magB = Math.sqrt(magnitudeB);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (magA * magB);
}

