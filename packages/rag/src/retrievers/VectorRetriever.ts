import type {
  Retriever,
  RetrievalResult,
  RetrievalOptions,
  VectorStoreCore,
  Embedder,
} from '../types.js';

export interface VectorRetrieverOptions {
  /** The vector store to query. */
  vectorStore: VectorStoreCore;
  /** The embedder to convert query text to vectors. */
  embedder: Embedder;
  /** The index name to query. */
  indexName: string;
  /** Default number of results to return. Default: 10. */
  topK?: number;
}

/**
 * Retriever backed by vector similarity search.
 *
 * Embeds the query using the provided Embedder, then queries the
 * VectorStore for the most similar entries.
 */
export class VectorRetriever implements Retriever {
  private readonly vectorStore: VectorStoreCore;
  private readonly embedder: Embedder;
  private readonly indexName: string;
  private readonly defaultTopK: number;

  constructor(options: VectorRetrieverOptions) {
    this.vectorStore = options.vectorStore;
    this.embedder = options.embedder;
    this.indexName = options.indexName;
    this.defaultTopK = options.topK ?? 10;
  }

  async retrieve(
    query: string,
    options?: RetrievalOptions,
  ): Promise<RetrievalResult[]> {
    // Use pre-computed query embedding when available to avoid double-embed cost
    const queryVector = options?.queryEmbedding ?? await this.embedder.embed(query);
    const topK = options?.topK ?? this.defaultTopK;
    const includeVectors = options?.includeEmbeddings ?? false;

    const results = await this.vectorStore.query(this.indexName, {
      queryVector,
      topK,
      filter: options?.filter,
      includeDocuments: true,
      includeVectors,
    });

    return results.map(r => ({
      id: r.id,
      text: r.document ?? '',
      score: r.score,
      relevanceScore: r.score,
      snippet: r.document ? r.document.slice(0, 240) : undefined,
      metadata: r.metadata,
      sourceId: typeof r.metadata?.sourceDocId === 'string' ? r.metadata.sourceDocId : this.indexName,
      embedding: r.vector,
    }));
  }
}
