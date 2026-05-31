import type { LanguageModel } from 'ai';

// ---------------------------------------------------------------------------
// CAG (Chunk and Generate) primitives
// ---------------------------------------------------------------------------

export type KnowledgeChunk = {
  id: string;
  text: string;
  meta?: Record<string, unknown>;
  /** Estimated token count for this chunk (set by token-aware chunkers). */
  tokens?: number;
};

export interface KnowledgeSource {
  id: string;
  name: string;
  description?: string;
  getChunks(): KnowledgeChunk[];
  dumpContent?(): string;
}

/**
 * Chunker interface for the CAG pattern. Returns KnowledgeChunk[].
 * Used by createStaticKnowledgeSource, createMarkdownChunker,
 * createRecursiveChunker.
 */
export interface Chunker {
  chunk(text: string, options?: ChunkOptions): KnowledgeChunk[];
}

export type ChunkOptions = {
  /** Maximum characters per chunk. Honored by character-based chunkers. */
  maxChars?: number;
  /** Character overlap between consecutive chunks. Honored by character-based chunkers. */
  overlapChars?: number;
  /** Maximum tokens per chunk. Honored by token-aware chunkers; ignored elsewhere. */
  maxTokens?: number;
  /** Token overlap between consecutive chunks. Honored by token-aware chunkers; ignored elsewhere. */
  overlapTokens?: number;
};

/**
 * Function that counts the number of tokens in a text string.
 * Implementations may use js-tiktoken, gpt-tokenizer, or any
 * other tokenizer. When not provided, the token chunker falls
 * back to character-based estimation (~4 chars per token).
 */
export type TokenCounter = (text: string) => number;

export type TokenChunkOptions = {
  /** Maximum tokens per chunk. Default: 512. */
  maxTokens?: number;
  /** Overlap in tokens between consecutive chunks. Default: 0. */
  overlapTokens?: number;
};

export type RetrievalHit = {
  sourceId: string;
  chunkId: string;
  rank: number;
  score?: number;
  reason?: string;
};

export interface KnowledgeRetriever {
  retrieve(
    query: string,
    sources: KnowledgeSource[],
    options?: { topK?: number; hint?: string }
  ): Promise<RetrievalHit[]>;
}

export type LLMRetrieverOptions = {
  model: LanguageModel;
  topK?: number;
  includeReasons?: boolean;
  candidateMaxChars?: number;
};

// ---------------------------------------------------------------------------
// Vector RAG abstractions
// ---------------------------------------------------------------------------

// -- Chunk ------------------------------------------------------------------

/**
 * Extended chunk type with positional and token metadata.
 * KnowledgeChunk is a subset of this (id + text + meta).
 */
export interface Chunk {
  /** Unique identifier for this chunk within its source. */
  id: string;
  /** The chunk text content. */
  text: string;
  /** Arbitrary metadata (heading, section name, source path, etc.). */
  metadata?: Record<string, unknown>;
  /** Character offset of the chunk start in the original text. */
  startIndex?: number;
  /** Character offset of the chunk end in the original text. */
  endIndex?: number;
  /** Estimated token count for this chunk. */
  tokens?: number;
}

// -- Document ---------------------------------------------------------------

/**
 * A document loaded from an external source.
 * Documents are the input to the chunking stage of the RAG pipeline.
 */
export interface Document {
  /** Unique identifier for this document. */
  id: string;
  /** The document's text content. */
  text: string;
  /** Source metadata (file path, URL, content type, title, etc.). */
  metadata?: Record<string, unknown>;
}

// -- DocumentLoader ---------------------------------------------------------

/**
 * Contract for loading documents from external sources.
 */
export interface DocumentLoader {
  /**
   * Load documents from the configured source.
   *
   * @returns Array of documents. A single source may produce multiple
   *   documents (e.g., a directory loader produces one per file).
   */
  load(): Promise<Document[]>;
}

// -- Embedder ---------------------------------------------------------------

/**
 * Contract for embedding text into dense vector representations.
 *
 * Implementations may wrap any embedding provider: Vercel AI SDK models,
 * OpenAI API directly, local models (Ollama, transformers.js), or
 * third-party services (Cohere, Voyage, Jina).
 */
export interface Embedder {
  /**
   * Embed a single text string into a dense vector.
   */
  embed(text: string): Promise<readonly number[]>;

  /**
   * Embed multiple text strings into dense vectors.
   * Implementations SHOULD batch the underlying API calls where the
   * provider supports it, rather than calling embed() in a loop.
   */
  embedMany(texts: string[]): Promise<readonly (readonly number[])[]>;

  /**
   * The dimensionality of the embedding vectors produced by this embedder.
   * May be undefined if the dimension is not known until the first embed() call.
   */
  readonly dimension?: number;
}

// -- VectorStore ------------------------------------------------------------

/**
 * A single entry to upsert into a vector index.
 */
export interface VectorEntry {
  /** Unique identifier for this vector. Overwrites if exists. */
  id: string;
  /** Dense vector representation. */
  vector: readonly number[];
  /** Arbitrary key-value metadata for filtering. */
  metadata?: Record<string, unknown>;
  /** Original text content. Stored alongside the vector for retrieval. */
  document?: string;
}

/**
 * Result of a vector similarity query.
 */
export interface VectorQueryResult {
  /** The vector entry's unique identifier. */
  id: string;
  /** Similarity score. Higher values indicate greater similarity. */
  score: number;
  /** Metadata associated with the vector entry. */
  metadata?: Record<string, unknown>;
  /** Original text content, if stored and requested. */
  document?: string;
  /** The raw vector, if includeVectors was true. */
  vector?: readonly number[];
}

/**
 * Parameters for querying a vector index.
 */
export interface VectorQueryParams {
  /** The query vector to find similar entries for. */
  queryVector: readonly number[];
  /** Maximum number of results to return. Default: 10. */
  topK?: number;
  /** Metadata filter in MongoDB-style operator syntax. */
  filter?: VectorFilter;
  /** Whether to include the raw vectors in results. Default: false. */
  includeVectors?: boolean;
  /** Whether to include the stored document text. Default: true. */
  includeDocuments?: boolean;
}

/**
 * Parameters for creating a vector index.
 */
export interface CreateIndexParams {
  /** Name of the index to create. */
  indexName: string;
  /** Dimensionality of the vectors. Must match the embedder's output. */
  dimension: number;
  /** Distance metric for similarity computation. Default: 'cosine'. */
  metric?: 'cosine' | 'euclidean' | 'dotproduct';
}

/**
 * Statistics about a vector index.
 */
export interface IndexStats {
  /** Dimensionality of stored vectors. */
  dimension: number;
  /** Total number of vectors in the index. */
  count: number;
  /** Distance metric configured for this index. */
  metric: 'cosine' | 'euclidean' | 'dotproduct';
}

/**
 * MongoDB-style filter operators for vector metadata queries.
 */
export type VectorFilter =
  | VectorFilterCondition
  | { $and: VectorFilter[] }
  | { $or: VectorFilter[] }
  | { $not: VectorFilter };

export type VectorFilterCondition = Record<
  string,
  | unknown                               // equality: { field: value }
  | { $eq?: unknown }
  | { $ne?: unknown }
  | { $gt?: number }
  | { $gte?: number }
  | { $lt?: number }
  | { $lte?: number }
  | { $in?: unknown[] }
  | { $nin?: unknown[] }
  | { $exists?: boolean }
>;

/**
 * Core read/write contract for persistent vector storage and similarity
 * search (REQ-16).
 *
 * Every vector-store adapter — including edge/serverless adapters that
 * cannot manage indexes at runtime (Cloudflare Vectorize, Upstash
 * Vector) — MUST implement this interface.
 *
 * Index lifecycle (create/delete) is split out as `VectorStoreIndexAdmin`
 * (REQ-17) so edge adapters that provision indexes out-of-band don't
 * have to ship silent no-ops or throwing stubs.
 *
 * Callers that need admin capabilities gate with `hasIndexAdmin(store)`.
 */
export interface VectorStoreCore {
  /**
   * Insert or update vector entries in an index.
   * If an entry with the same ID exists, it is overwritten.
   */
  upsert(indexName: string, entries: VectorEntry[]): Promise<void>;

  /**
   * Query an index for vectors similar to the given query vector.
   */
  query(
    indexName: string,
    params: VectorQueryParams,
  ): Promise<VectorQueryResult[]>;

  /**
   * Get statistics about an index.
   */
  describeIndex(indexName: string): Promise<IndexStats>;

  /**
   * List all index names in this vector store.
   *
   * Edge adapters that are provisioned as a single logical index
   * return that index's name (typically `['default']`).
   */
  listIndexes(): Promise<string[]>;
}

/**
 * Optional index-administration contract for vector stores (REQ-16).
 *
 * Adapters that can manage indexes at runtime (Postgres, Redis, LanceDB)
 * implement this alongside `VectorStoreCore`. Edge adapters whose
 * indexes are provisioned out-of-band (Cloudflare Vectorize via
 * `wrangler.toml`, Upstash Vector via its dashboard) MUST NOT
 * implement this — attempting admin calls on them should be a
 * typecheck error, not a runtime no-op (REQ-17).
 */
export interface VectorStoreIndexAdmin {
  /**
   * Create a new vector index with the specified configuration.
   * Implementations SHOULD be idempotent.
   */
  createIndex(params: CreateIndexParams): Promise<void>;

  /**
   * Delete an index and all its vectors.
   */
  deleteIndex(indexName: string): Promise<void>;

  /**
   * Delete specific vectors from an index, either by id or by filter.
   */
  deleteVectors(
    indexName: string,
    params: { ids?: string[]; filter?: VectorFilter },
  ): Promise<void>;
}

/**
 * Structural type-guard for callers that need runtime admin capabilities.
 * Use in tools, retrievers, and contract tests that gate admin-only paths.
 *
 * ```ts
 * if (hasIndexAdmin(store)) {
 *   await store.createIndex(...); // typechecks
 * }
 * ```
 */
export function hasIndexAdmin(
  store: VectorStoreCore,
): store is VectorStoreCore & VectorStoreIndexAdmin {
  const candidate = store as Partial<VectorStoreIndexAdmin>;
  return (
    typeof candidate.createIndex === 'function' &&
    typeof candidate.deleteIndex === 'function' &&
    typeof candidate.deleteVectors === 'function'
  );
}

// -- Retriever --------------------------------------------------------------

/**
 * A single result from a retrieval operation.
 */
export interface RetrievalResult {
  /** Identifier of the retrieved chunk or document. */
  id: string;
  /** The retrieved text content. */
  text: string;
  /** Stable source identifier for citation tracking. */
  sourceId: string;
  /** Relevance score. Higher is more relevant. */
  score?: number;
  /** Mirrors score for runtimes that consume citation relevance explicitly. */
  relevanceScore?: number;
  /** Short preview used by citation cards. */
  snippet?: string;
  /** Metadata associated with the retrieved item. */
  metadata?: Record<string, unknown>;
  /** Human-readable reason for selection. */
  reason?: string;
  /**
   * The embedding vector for this result's text content.
   * Populated when the retriever requests `includeVectors: true` from the
   * vector store. Used by RetrievalCache to index results by document
   * embedding without a separate embed() call.
   */
  embedding?: readonly number[];
}

/**
 * Options for retrieval operations.
 */
export interface RetrievalOptions {
  /** Maximum number of results to return. */
  topK?: number;
  /** Metadata filter (for vector-backed retrievers). */
  filter?: VectorFilter;
  /** Optional hint or context to guide the retriever. */
  hint?: string;
  /**
   * Pre-computed query embedding vector. When provided, vector-backed
   * retrievers SHOULD skip the embed(query) call and use this vector
   * directly. Prevents double-embedding when the caller (e.g.,
   * RetrievalCache) has already embedded the query for cache lookup.
   */
  queryEmbedding?: readonly number[];
  /**
   * Whether to include embedding vectors in retrieval results.
   * When true, retrievers that use a VectorStore will request
   * `includeVectors: true` and map the result vectors onto
   * `RetrievalResult.embedding`. Default: false.
   */
  includeEmbeddings?: boolean;
}

/**
 * Contract for retrieving relevant content given a query.
 */
export interface Retriever {
  /**
   * Retrieve relevant content for a query.
   */
  retrieve(
    query: string,
    options?: RetrievalOptions,
  ): Promise<RetrievalResult[]>;
}

// -- Reranker ---------------------------------------------------------------

/**
 * Options for reranking operations.
 */
export interface RerankerOptions {
  /** Maximum number of results to return after reranking. */
  topK?: number;
}

/**
 * Contract for post-retrieval result reranking.
 */
export interface Reranker {
  /**
   * Rerank retrieval results by relevance to the query.
   */
  rerank(
    query: string,
    results: RetrievalResult[],
    options?: RerankerOptions,
  ): Promise<RetrievalResult[]>;
}
