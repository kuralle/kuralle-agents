import type {
  Retriever,
  Reranker,
  RetrievalResult,
  RetrievalOptions,
  VectorStoreCore,
  Embedder,
  VectorFilter,
} from '../types.js';
import type { KeywordIndex } from '../search/KeywordIndex.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FusionRetrieverOptions {
  /**
   * The keyword index for the BM25 tier — in-memory `BM25Index` or
   * persistent `Fts5KeywordIndex`.
   */
  keywordIndex: KeywordIndex;
  /** The vector store for semantic search. */
  vectorStore: VectorStoreCore;
  /** The embedder to convert query text to vectors. */
  embedder: Embedder;
  /** The index name in the vector store. */
  indexName: string;
  /**
   * Weight for BM25 scores in the fused result. The vector weight is
   * `1 - bm25Weight`. Default: 0.3 (70% vector, 30% keyword).
   */
  bm25Weight?: number;
  /** Optional post-retrieval reranker. */
  reranker?: Reranker;
  /** Default number of results to return. Default: 10. */
  topK?: number;
  /**
   * Number of candidates to fetch from each source before fusion.
   * Should be >= topK. Default: topK * 3.
   */
  fetchK?: number;
}

// ---------------------------------------------------------------------------
// FusionRetriever
// ---------------------------------------------------------------------------

/**
 * Retriever that fuses BM25 keyword search with vector similarity search
 * using weighted linear combination of min-max normalized scores.
 *
 * Unlike HybridRetriever (which uses rank-based RRF and is agnostic to
 * the underlying retriever type), FusionRetriever is purpose-built for
 * the BM25+vector combination. It runs both searches in parallel, normalizes
 * scores to [0,1] via min-max, and combines them with configurable weights.
 *
 * An optional reranker can refine results after fusion.
 */
export class FusionRetriever implements Retriever {
  private readonly keywordIndex: KeywordIndex;
  private readonly vectorStore: VectorStoreCore;
  private readonly embedder: Embedder;
  private readonly indexName: string;
  private readonly bm25Weight: number;
  private readonly reranker?: Reranker;
  private readonly defaultTopK: number;
  private readonly fetchK?: number;

  constructor(options: FusionRetrieverOptions) {
    this.keywordIndex = options.keywordIndex;
    this.vectorStore = options.vectorStore;
    this.embedder = options.embedder;
    this.indexName = options.indexName;
    this.bm25Weight = options.bm25Weight ?? 0.3;
    this.reranker = options.reranker;
    this.defaultTopK = options.topK ?? 10;
    this.fetchK = options.fetchK;
  }

  async retrieve(
    query: string,
    options?: RetrievalOptions,
  ): Promise<RetrievalResult[]> {
    const topK = options?.topK ?? this.defaultTopK;
    const fetchK = this.fetchK ?? topK * 3;
    const includeVectors = options?.includeEmbeddings ?? false;

    // Embed query (or reuse pre-computed embedding)
    const queryVector = options?.queryEmbedding ?? await this.embedder.embed(query);

    // Run BM25 and vector search in parallel
    const [bm25Results, vectorResults] = await Promise.all([
      Promise.resolve(this.keywordIndex.search(query, fetchK)),
      this.vectorStore.query(this.indexName, {
        queryVector,
        topK: fetchK,
        filter: options?.filter,
        includeDocuments: true,
        includeVectors,
      }),
    ]);

    // Build lookup maps from vector results (source of text + metadata)
    const vectorMap = new Map(
      vectorResults.map(r => [r.id, r]),
    );

    // Min-max normalize BM25 scores
    const bm25Scores = new Map<string, number>();
    if (bm25Results.length > 0) {
      const maxBm25 = bm25Results[0].score;
      const minBm25 = bm25Results[bm25Results.length - 1].score;
      const range = maxBm25 - minBm25;
      for (const r of bm25Results) {
        bm25Scores.set(r.id, range > 0 ? (r.score - minBm25) / range : 1);
      }
    }

    // Min-max normalize vector scores
    const vectorScores = new Map<string, number>();
    if (vectorResults.length > 0) {
      let maxVec = -Infinity;
      let minVec = Infinity;
      for (const r of vectorResults) {
        if (r.score > maxVec) maxVec = r.score;
        if (r.score < minVec) minVec = r.score;
      }
      const range = maxVec - minVec;
      for (const r of vectorResults) {
        vectorScores.set(r.id, range > 0 ? (r.score - minVec) / range : 1);
      }
    }

    // Collect all unique document IDs
    const allIds = new Set<string>([
      ...bm25Scores.keys(),
      ...vectorScores.keys(),
    ]);

    // Fuse scores with weighted combination
    const vectorWeight = 1 - this.bm25Weight;
    const fused: Array<{ id: string; score: number }> = [];

    for (const id of allIds) {
      const bScore = bm25Scores.get(id) ?? 0;
      const vScore = vectorScores.get(id) ?? 0;
      fused.push({
        id,
        score: this.bm25Weight * bScore + vectorWeight * vScore,
      });
    }

    // Sort by fused score descending
    fused.sort((a, b) => b.score - a.score);

    // Map to RetrievalResult, preferring vector result for text/metadata
    const candidateK = this.reranker ? fused.length : topK;
    let results: RetrievalResult[] = fused.slice(0, candidateK).map(f => {
      const vr = vectorMap.get(f.id);
      return {
        id: f.id,
        text: vr?.document ?? '',
        score: f.score,
        relevanceScore: f.score,
        snippet: vr?.document ? vr.document.slice(0, 240) : undefined,
        metadata: vr?.metadata,
        sourceId: typeof vr?.metadata?.sourceDocId === 'string' ? vr.metadata.sourceDocId : this.indexName,
        embedding: vr?.vector,
      };
    });

    if (this.reranker) {
      results = await this.reranker.rerank(query, results, { topK });
    }

    return results.slice(0, topK);
  }
}
