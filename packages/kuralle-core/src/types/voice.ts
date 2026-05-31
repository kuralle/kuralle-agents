// ============================================
// VOICE-CRITICAL INFRASTRUCTURE
//
// Voice sessions are the highest-throughput consumer of two cross-cutting
// subsystems, so their types live here even though text sessions also use
// them:
//   1. Knowledge retrieval — voice latency budget demands sub-millisecond
//      lookup; the three-layer architecture (compiled, cache, hybrid) is
//      motivated by voice.
//   2. Stream/callback plumbing — voice produces many more stream parts
//      per session than text; HarnessStreamPart, StreamCallback, and
//      HttpCallbackConfig describe the hot-path event flow.
// ============================================

import type { ConversationOutcome, ConversationOutcomeMarkedBy } from '../outcomes/types.js';
import type { ChannelId } from './session.js';

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
  part: HarnessStreamPart;
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
   * - message: emit message-oriented events (input, done, error, tripwire, plus tool/transition events per toggles)
   * - all: emit every runtime event (legacy/high-volume behavior)
   * Default: message
   */
  eventMode?: 'message' | 'all';
  /**
   * Emit streaming text-delta events.
   * Default: false (final text is emitted on terminal events via fullText)
   */
  emitTextDeltas?: boolean;
  /**
   * Emit tool lifecycle events (tool-call/tool-result/tool-error) in message mode.
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

// ============================================
// HARNESS STREAM PART
// ============================================

export type HarnessStreamPart =
  | { type: 'input'; text: string; userId?: string }
  | { type: 'text-delta'; text: string }
  | { type: 'channel-switched'; from: ChannelId; to: ChannelId; conversationId: string }
  | {
      type: 'channel-policy-applied';
      channelId: ChannelId;
      changes: Array<'strip-markdown' | 'strip-emojis' | 'truncate' | 'custom'>;
      beforeLen: number;
      afterLen: number;
    }
  | {
      type: 'conversation-outcome';
      outcome: ConversationOutcome;
      reason?: string;
      markedBy: ConversationOutcomeMarkedBy;
    }
  | { type: 'tripwire'; phase: 'input' | 'output'; processorId: string; reason: string; message?: string }
  | { type: 'pipeline-refinement-start'; capabilities: string[] }
  | { type: 'pipeline-refinement-end'; aggregate: 'continue' | 'rewrite' | 'escalate' | 'block'; confidence: number; latencyMs: number }
  | { type: 'pipeline-refinement-rewrite'; before: string; after: string; rationale: string }
  | { type: 'pipeline-validation-start'; capabilities: string[] }
  | { type: 'pipeline-validation-end'; aggregate: 'continue' | 'rewrite' | 'block'; confidence: number; latencyMs: number }
  | { type: 'pipeline-validation-block'; rationale: string; userFacingMessage?: string }
  | {
      type: 'safety-blocked';
      moderator: string;
      rationale: string;
      userFacingMessage: string;
      handlerOutcome?: 'queued' | 'connected' | 'failed';
    }
  | {
      type: 'safety-rewritten';
      moderator: string;
      beforeLen: number;
      afterLen: number;
      before?: string;
      after?: string;
    }
  | { type: 'safety-slow'; moderator: string; latencyMs: number; deadlineMs: number }
  | {
      type: 'escalation-triggered';
      reason: 'low-confidence' | 'user-request' | 'frustration' | 'tool-call' | 'safety-block';
      confidence?: number;
      handlerOutcome?: 'queued' | 'connected' | 'failed';
      handoverMessage: string;
    }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown }
  | { type: 'tool-error'; toolCallId: string; toolName: string; error: string }
  | { type: 'handoff'; from: string; to: string; reason: string }
  | { type: 'node-enter'; nodeName: string }
  | { type: 'node-exit'; nodeName: string }
  | { type: 'flow-transition'; from: string; to: string }
  | { type: 'flow-end'; reason: string }
  | { type: 'turn-end' }
  | { type: 'step-start'; step: number; agentId: string }
  | { type: 'step-end'; step: number; agentId: string; latencyMs?: number; ttftMs?: number }
  | {
      type: 'persona-applied';
      personaName: string;
      experiment?: { cohort: 'control' | 'variant'; allocationPct: number };
    }
  | {
      type: 'agent-start';
      agentId: string;
      personaName?: string;
      experiment?: { cohort: 'control' | 'variant'; allocationPct: number };
    }
  | { type: 'agent-end'; agentId: string }
  | {
      type: 'context-compacted';
      messagesBefore: number;
      messagesAfter: number;
      /** Estimated input tokens before compaction. */
      tokensBefore?: number;
      /** Estimated input tokens after compaction. */
      tokensAfter?: number;
      /** 0–100. */
      savingsPct?: number;
      /** Strategy actually used (may differ from configured if cooldown fired). */
      strategy?: 'truncate' | 'summarize';
      /** Wall-clock ms inside autoCompactMessages. */
      latencyMs?: number;
      /** Summarizer model id, when summarize path ran. */
      summaryModel?: string;
    }
  | {
      type: 'compaction-skipped';
      /** Why compaction was triggered but bailed out without changing messages. */
      reason: 'thrashing' | 'cooldown';
      /** Message count at the time of the skip — for caller diagnostics. */
      messagesCount: number;
    }
  | {
      type: 'compaction-scheduled';
      /**
       * Where the work will run:
       *   - 'background' = off-thread (voice mode default; PR-18)
       *   - 'foreground' = blocking the current turn (text default)
       */
      when: 'background' | 'foreground';
      /** Message count at the time of scheduling. */
      messagesCount: number;
    }
  | {
      type: 'facts-evicted';
      /** Keys removed from session.workingMemory.__keyFacts because they exceeded factTtlSeconds. */
      evictedKeys: string[];
      /** TTL configured in seconds (for caller diagnostics). */
      ttlSeconds: number;
    }
  | {
      type: 'context-overflow-recovered';
      /** Provider error message that triggered recovery (truncated to 200 chars). */
      errorMessage: string;
      /** Messages stripped from the failed turn before re-compacting. */
      messagesStripped: number;
      /** Whether the post-recovery autoCompactMessages call actually compacted. */
      compacted: boolean;
      /** How many recovery attempts have occurred this step (1 = first attempt). */
      attempt: number;
    }
  | {
      type: 'turn-timeout';
      /** Which deadline tripped: 'overall' (turnTimeoutMs) or 'zero-token' (zeroTokenTimeoutMs). */
      kind: 'overall' | 'zero-token';
      /** Configured deadline in ms. */
      deadlineMs: number;
      /** ms from LLM call start to abort. */
      elapsedMs: number;
      /** True if the model produced ANY content before the deadline. */
      anyOutput: boolean;
      /** Agent id whose turn was aborted. */
      agentId: string;
    }
  | { type: 'result-evicted'; toolCallId: string; filepath: string }
  | { type: 'interrupted'; sessionId: string; reason: string; timestamp: Date; lastAgentId?: string; lastStep?: number }
  | { type: 'custom'; name: string; data: unknown; timestamp?: Date }
  | { type: 'tool-start'; toolCallId: string; toolName: string; message?: string }
  | { type: 'tool-done'; toolCallId: string; toolName: string; durationMs: number }
  | { type: 'error'; error: string }
  | { type: 'suggested-questions'; suggestions: string[]; isPartial?: boolean }
  | { type: 'text-clear'; agentId: string }
  | { type: 'knowledge-retrieval-start'; query: string; message?: string }
  | { type: 'knowledge-cache-hit'; query: string; resultCount: number; latencyMs: number }
  | { type: 'knowledge-cache-miss'; query: string; latencyMs: number }
  | { type: 'knowledge-search'; query: string; resultCount: number; latencyMs: number; layer: 'cache' | 'hybrid' }
  | { type: 'knowledge-citation'; sourceId: string; title?: string; url?: string; lastModified?: string; score?: number }
  | { type: 'knowledge-no-results'; query: string; reason: 'empty-corpus' | 'no-match' | 'retriever-error' }
  | { type: 'knowledge-prefetch'; keywords: string[]; resultCount: number }
  | { type: 'knowledge-compiled'; tokenCount: number }
  | { type: 'knowledge-quality-check'; query: string; quality: 'high' | 'medium' | 'low'; topScore: number; avgScore: number; coverageEstimate: number }
  | { type: 'knowledge-reformulation'; originalQuery: string; reformulatedQuery: string; trigger: 'inline' | 'background'; latencyMs: number }
  | { type: 'done'; sessionId: string; userId?: string };
