// ---------------------------------------------------------------------------
// CAG (Chunk and Generate) primitives
// ---------------------------------------------------------------------------

export type {
  KnowledgeChunk,
  KnowledgeSource,
  Chunker,
  ChunkOptions,
  TokenCounter,
  TokenChunkOptions,
  RetrievalHit,
  KnowledgeRetriever,
  LLMRetrieverOptions,
} from './types.js';

export { createMarkdownChunker, createRecursiveChunker, createTokenChunker } from './chunkers.js';
export type { TokenChunkerConfig } from './chunkers.js';
export { createStaticKnowledgeSource } from './source.js';
export { createLLMRetriever } from './llmRetriever.js';

// ---------------------------------------------------------------------------
// Vector RAG primitives
// ---------------------------------------------------------------------------

// Types
export type {
  Chunk,
  Document,
  DocumentLoader,
  Embedder,
  VectorEntry,
  VectorQueryResult,
  VectorQueryParams,
  CreateIndexParams,
  IndexStats,
  VectorFilter,
  VectorFilterCondition,
  VectorStoreCore,
  VectorStoreIndexAdmin,
  RetrievalResult,
  RetrievalOptions,
  Retriever,
  RerankerOptions,
  Reranker,
} from './types.js';

// Vector-store capability type-guard (REQ-16 / REQ-17)
export { hasIndexAdmin } from './types.js';

// Embedders
export { AiSdkEmbedder } from './embedders/index.js';
export type { AiSdkEmbedderOptions } from './embedders/index.js';

// Vector stores
export { InMemoryVectorStore } from './vectorStores/index.js';
export { detectRuntime } from './vectorStores/index.js';
export type { RuntimeEnvironment, RuntimeInfo } from './vectorStores/index.js';

// Vector filter translators (canonical site; adapters import from here)
export {
  UnsupportedFilterOperatorError,
  toSqlWhere,
  toLanceDbWhere,
  toUpstashFilterString,
  toRedisFilter,
  toCloudflareFilter,
  matchFilter,
} from './filters/index.js';
export type { SqlWhereResult } from './filters/index.js';

// Retrievers
export { VectorRetriever } from './retrievers/index.js';
export type { VectorRetrieverOptions } from './retrievers/index.js';
export { HybridRetriever } from './retrievers/index.js';
export type { HybridRetrieverSource, HybridRetrieverOptions } from './retrievers/index.js';
export { FusionRetriever } from './retrievers/index.js';
export type { FusionRetrieverOptions } from './retrievers/index.js';
export { MultiHopRetriever } from './retrievers/index.js';
export type { MultiHopRetrieverOptions, QueryDecomposer } from './retrievers/index.js';

// Rerankers
export { LLMReranker } from './rerankers/index.js';
export type { LLMRerankerOptions } from './rerankers/index.js';
export { CohereReranker } from './rerankers/index.js';
export type { CohereRerankerOptions } from './rerankers/index.js';

// Search
export { BM25Index, Fts5KeywordIndex, tokenizeKeywords } from './search/index.js';
export type {
  BM25Document,
  BM25SearchResult,
  BM25IndexOptions,
  KeywordIndex,
  Fts5KeywordIndexOptions,
} from './search/index.js';

// SQL executor contract (shared by Fts5KeywordIndex and SqlIngestManifest)
export { execSql, assertSqlIdentifier } from './sql.js';
export type { SqlExecutor } from './sql.js';

// Cache
export { RetrievalCache } from './cache/index.js';
export type { RetrievalCacheConfig } from './cache/index.js';
export { TurnCache } from './cache/index.js';
export { PredictivePreFetcher } from './cache/index.js';
export type { PredictivePreFetcherConfig, TopicPredictor } from './cache/index.js';

// Compiler
export { KnowledgeCompiler } from './compiler/index.js';
export type { KnowledgeCompilerConfig, CompilationResult } from './compiler/index.js';

// Pipeline
export { RagPipeline } from './pipeline/index.js';
export type { RagPipelineOptions } from './pipeline/index.js';
export {
  InMemoryIngestManifest,
  SqlIngestManifest,
  sha256Hex,
} from './pipeline/index.js';
export type {
  IngestManifest,
  IngestManifestData,
  IngestManifestDocEntry,
  SqlIngestManifestOptions,
} from './pipeline/index.js';
export { RetrievalQualityChecker } from './pipeline/index.js';
export type {
  RetrievalQualityCheckerOptions,
  QualityCheckResult,
  QueryReformulator,
} from './pipeline/index.js';

// createVectorRetrievalTool now lives in @kuralle-agents/tools (C-8.4).
// Under alpha's direct-removal posture the rag-side re-export is gone —
// import from @kuralle-agents/tools instead.
