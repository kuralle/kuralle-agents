import type { StreamPart } from './stream.js';

// ============================================
// KNOWLEDGE TYPES
// ============================================

/**
 * Runtime-level knowledge configuration. Configured once on the Runtime,
 * inherited by all agents. Per-agent overrides via `AgentKnowledgeOverrides`
 * can only reduce capabilities (e.g., disable compiled knowledge, restrict
 * topK, filter by metadata).
 */
export interface KnowledgeProviderConfig {
  /**
   * Retriever for hybrid search (Layer 3). Any object implementing the
   * Retriever interface from `@kuralle-agents/rag`. When not provided,
   * only compiled knowledge and cache are available.
   */
  retriever?: KnowledgeRetrieverAdapter;

  /**
   * Embedder for cache similarity lookup. Required when `retriever` is
   * provided (needed for cache population and query embedding).
   */
  embedder?: KnowledgeEmbedderAdapter;

  /**
   * Pre-compiled knowledge content (Layer 1). Injected into the system
   * prompt every turn with zero search latency. Produced offline by
   * KnowledgeCompiler.
   */
  compiled?: string;

  /**
   * Retrieval cache configuration. When omitted, a default configuration
   * is used (maxEntries: 256, ttlMs: 300000, similarityThreshold: 0.85).
   */
  cache?: {
    /** Maximum entries in the LRU cache. Default: 256. */
    maxEntries?: number;
    /** Cache entry TTL in milliseconds. Default: 300000 (5 minutes). */
    ttlMs?: number;
    /** Minimum cosine similarity for a cache hit. Default: 0.85. */
    similarityThreshold?: number;
  };

  /**
   * Predictive pre-fetch configuration. When enabled, the system
   * predicts follow-up topics from the conversation window and
   * pre-fetches relevant content into the session cache.
   */
  prefetch?: {
    /** Enable predictive pre-fetching. Default: false. */
    enabled?: boolean;
    /** Number of keywords to extract per prediction. Default: 3. */
    maxKeywords?: number;
    /** Number of recent messages to analyze. Default: 5. */
    conversationWindow?: number;
  };

  /**
   * Default retrieval options applied to all agents unless overridden.
   */
  defaults?: {
    /** Maximum results from Layer 3 search. Default: 5. */
    topK?: number;
    /** Maximum tokens for retrieval context in the system prompt. Default: 2000. */
    maxOutputTokens?: number;
    /** Whether to include embedding vectors in results (for cache writeback). Default: true. */
    includeEmbeddings?: boolean;
  };

  /**
   * Retrieval quality checking configuration. When configured, retrieval
   * results are evaluated using score distribution (sub-millisecond).
   * For text agents, low-quality results trigger inline reformulation.
   * For voice agents, low-quality results trigger background reformulation
   * via the pre-fetcher.
   */
  qualityCheck?: {
    /** Minimum top-result score to consider quality "high". Default: 0.5. */
    highThreshold?: number;
    /** Minimum top-result score to consider quality "medium". Default: 0.3. */
    mediumThreshold?: number;
    /**
     * Query reformulator callback. When provided and quality is "low",
     * the system rewrites the query and re-retrieves.
     */
    reformulate?: (query: string, results: KnowledgeRetrievalResult[]) => Promise<string>;
  };

  /**
   * How retrieved source references should be rendered into the model prompt.
   * Defaults to 'footnotes'.
   */
  renderCitations?: 'inline' | 'footnotes' | 'off';
}

/**
 * Per-agent knowledge overrides. Can only reduce capabilities — cannot
 * add a retriever that doesn't exist at the Runtime level.
 */
export interface AgentKnowledgeOverrides {
  /** Disable compiled knowledge injection for this agent. */
  compiledEnabled?: boolean;
  /** Disable retrieval tool for this agent. */
  toolEnabled?: boolean;
  /** Override topK (must be <= Runtime default). */
  topK?: number;
  /** Override max output tokens (must be <= Runtime default). */
  maxOutputTokens?: number;
  /** Metadata filter restricting which documents this agent can access. */
  filter?: Record<string, unknown>;
}

/**
 * Adapter interface for retrievers used by KnowledgeProvider.
 * Mirrors the Retriever interface from `@kuralle-agents/rag` without
 * creating a dependency from core → rag.
 */
export interface KnowledgeRetrieverAdapter {
  retrieve(
    query: string,
    options?: {
      topK?: number;
      filter?: Record<string, unknown>;
      queryEmbedding?: readonly number[];
      includeEmbeddings?: boolean;
    },
  ): Promise<KnowledgeRetrievalResult[]>;
}

/**
 * Adapter interface for embedders used by KnowledgeProvider.
 * Mirrors the Embedder interface from `@kuralle-agents/rag`.
 */
export interface KnowledgeEmbedderAdapter {
  embed(text: string): Promise<readonly number[]>;
}

export interface SourceRef {
  readonly id: string;
  readonly title?: string;
  readonly url?: string;
  readonly lastModified?: string;
  readonly score?: number;
}

/**
 * A single result from knowledge retrieval, used across the pipeline.
 */
export interface KnowledgeRetrievalResult {
  id: string;
  text: string;
  sourceId: string;
  score?: number;
  relevanceScore?: number;
  snippet?: string;
  metadata?: Record<string, unknown>;
  embedding?: readonly number[];
}

export type KnowledgeChunk = KnowledgeRetrievalResult;

/**
 * Interface for the session-level retrieval cache. Implemented by
 * `RetrievalCache` from `@kuralle-agents/rag`. Defined here so
 * `RunContext.retrievalCache` can be properly typed without core
 * depending on rag.
 */
export interface RetrievalCacheAdapter {
  lookup(queryEmbedding: readonly number[], topK?: number): KnowledgeRetrievalResult[];
  populate(results: KnowledgeRetrievalResult[], queryEmbedding?: readonly number[]): void;
  readonly size: number;
}

// ============================================
// STREAM / CALLBACK INFRASTRUCTURE
// ============================================

export interface HttpCallbackConfig {
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  allowList?: string[];
  denyList?: string[];
  includeFullText?: boolean;
  timeoutMs?: number;
}

export interface StreamCallbackPayload {
  sessionId: string;
  agentId: string;
  timestamp: string;
  part: StreamPart;
  fullText?: string;
}

export interface StreamCallbackSink {
  name?: string;
  write: (payload: StreamCallbackPayload) => Promise<void>;
  close?: () => Promise<void>;
}

export interface StreamCallbackConfig {
  sinks?: StreamCallbackSink[];
  /**
   * Events to emit when no explicit allowList is provided.
   * - message: emit terminal events plus tool/transition events per toggles
   * - all: emit every runtime event
   * Default: message
   */
  eventMode?: 'message' | 'all';
  /**
   * Emit streaming text-delta events.
   * Default: false (final text is emitted on terminal events via fullText)
   */
  emitTextDeltas?: boolean;
  /**
   * Emit tool lifecycle events (tool-call/tool-result) in message mode.
   * Default: true
   */
  emitToolEvents?: boolean;
  /**
   * Emit transition lifecycle events (flow-transition/handoff) in message mode.
   * Default: true
   */
  emitTransitionEvents?: boolean;
  /**
   * Attach accumulated assistant text as fullText on terminal events.
   * Default: true
   */
  emitFinalText?: boolean;
  allowList?: string[];
  denyList?: string[];
  includeFullText?: boolean;
  maxQueueSize?: number;
  dropPolicy?: 'drop_oldest' | 'drop_newest';
  logDroppedEvents?: boolean;
  /** If true, wait for sink queue drain when a stream call ends. Default: false. */
  flushOnEnd?: boolean;
  flushTimeoutMs?: number;
}
