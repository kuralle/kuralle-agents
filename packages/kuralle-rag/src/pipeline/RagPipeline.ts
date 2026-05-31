import type {
  Embedder,
  VectorStoreCore,
  Chunker,
  Reranker,
  Document,
  RetrievalResult,
  RetrievalOptions,
  Retriever,
} from '../types.js';
import { hasIndexAdmin } from '../types.js';

export interface RagPipelineOptions {
  /** Embedder for converting text to vectors. */
  embedder: Embedder;
  /**
   * Vector store for persistent storage and similarity search.
   *
   * `ensureIndex()` additionally requires `VectorStoreIndexAdmin` to
   * provision indexes at runtime; passing a Core-only adapter (edge
   * stores such as Cloudflare Vectorize or Upstash Vector whose indexes
   * are provisioned out-of-band) is supported — `ensureIndex()` becomes
   * a no-op on those stores (REQ-17).
   */
  vectorStore: VectorStoreCore;
  /** Chunker for splitting documents into chunks. */
  chunker: Chunker;
  /** Index name for this pipeline's data. */
  indexName: string;
  /** Optional reranker for post-retrieval refinement. */
  reranker?: Reranker;
  /** Default topK for retrieval. Default: 10. */
  topK?: number;
  /** Distance metric for index creation. Default: 'cosine'. */
  metric?: 'cosine' | 'euclidean' | 'dotproduct';
  /** Batch size for embedMany calls. Default: 100. */
  batchSize?: number;
}

/**
 * Convenience class that wires embedder, vector store, chunker,
 * and optional reranker into a single ingestion + retrieval pipeline.
 *
 * Implements the Retriever interface so it can be passed directly
 * to createVectorRetrievalTool() or used as an agent retriever.
 */
export class RagPipeline implements Retriever {
  private readonly embedder: Embedder;
  private readonly vectorStore: VectorStoreCore;
  private readonly chunker: Chunker;
  private readonly indexName: string;
  private readonly reranker?: Reranker;
  private readonly defaultTopK: number;
  private readonly metric: 'cosine' | 'euclidean' | 'dotproduct';
  private readonly batchSize: number;

  constructor(options: RagPipelineOptions) {
    this.embedder = options.embedder;
    this.vectorStore = options.vectorStore;
    this.chunker = options.chunker;
    this.indexName = options.indexName;
    this.reranker = options.reranker;
    this.defaultTopK = options.topK ?? 10;
    this.metric = options.metric ?? 'cosine';
    this.batchSize = options.batchSize ?? 100;
  }

  /**
   * Ensure the vector index exists, creating it if necessary.
   * Requires at least one embed() call to determine dimension.
   *
   * On edge stores that only implement `VectorStoreCore` (indexes
   * provisioned out-of-band), this is a no-op — the store's own
   * `listIndexes()` is still consulted so a genuinely missing index
   * surfaces later at query time via the backend's own error.
   */
  async ensureIndex(): Promise<void> {
    const indexes = await this.vectorStore.listIndexes();
    if (indexes.includes(this.indexName)) return;

    if (!hasIndexAdmin(this.vectorStore)) {
      // Edge-only adapter; indexes are provisioned out-of-band.
      return;
    }

    let dimension = this.embedder.dimension;
    if (!dimension) {
      const probe = await this.embedder.embed('dimension probe');
      dimension = probe.length;
    }

    await this.vectorStore.createIndex({
      indexName: this.indexName,
      dimension,
      metric: this.metric,
    });
  }

  /**
   * Ingest documents: chunk, embed, and store in the vector store.
   */
  async ingest(documents: Document[]): Promise<void> {
    await this.ensureIndex();

    for (const doc of documents) {
      const chunks = this.chunker.chunk(doc.text);
      if (chunks.length === 0) continue;

      const texts = chunks.map(c => c.text);

      // Batch embedding to respect provider limits
      const allEmbeddings: (readonly number[])[] = [];
      for (let i = 0; i < texts.length; i += this.batchSize) {
        const batch = texts.slice(i, i + this.batchSize);
        const embeddings = await this.embedder.embedMany(batch);
        allEmbeddings.push(...embeddings);
      }

      const entries = chunks.map((chunk, i) => ({
        id: `${doc.id}:${chunk.id}`,
        vector: allEmbeddings[i],
        metadata: {
          ...(chunk.meta ?? {}),
          ...(doc.metadata ?? {}),
          sourceDocId: doc.id,
          chunkId: chunk.id,
        },
        document: chunk.text,
      }));

      await this.vectorStore.upsert(this.indexName, entries);
    }
  }

  /**
   * Retrieve relevant chunks for a query.
   * Implements the Retriever interface.
   */
  async retrieve(
    query: string,
    options?: RetrievalOptions,
  ): Promise<RetrievalResult[]> {
    const topK = options?.topK ?? this.defaultTopK;
    // Use pre-computed query embedding when available to avoid double-embed cost
    const queryVector = options?.queryEmbedding ?? await this.embedder.embed(query);
    const includeVectors = options?.includeEmbeddings ?? false;

    // Fetch more than topK if reranking, to give the reranker a wider pool
    const fetchK = this.reranker ? topK * 3 : topK;

    const results = await this.vectorStore.query(this.indexName, {
      queryVector,
      topK: fetchK,
      filter: options?.filter,
      includeDocuments: true,
      includeVectors,
    });

    let mapped: RetrievalResult[] = results.map(r => ({
      id: r.id,
      text: r.document ?? '',
      score: r.score,
      relevanceScore: r.score,
      snippet: r.document ? r.document.slice(0, 240) : undefined,
      metadata: r.metadata,
      sourceId: typeof r.metadata?.sourceDocId === 'string' ? r.metadata.sourceDocId : this.indexName,
      embedding: r.vector,
    }));

    if (this.reranker) {
      mapped = await this.reranker.rerank(query, mapped, { topK });
    }

    return mapped.slice(0, topK);
  }
}
