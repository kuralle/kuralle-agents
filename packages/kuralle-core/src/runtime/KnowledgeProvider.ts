/**
 * KnowledgeProvider — Runtime-level knowledge orchestrator.
 *
 * Implements three-layer retrieval:
 * - Layer 1 (compiled): Stable knowledge injected into system prompt (0ms)
 * - Layer 2 (cache): Semantic cache lookup via document embeddings (~0.4ms)
 * - Layer 3 (search): Hybrid search via configured retriever (50-150ms)
 *
 * Configured once on the Runtime, inherited by all agents. Per-agent
 * overrides restrict capabilities (filter, topK, disable compiled/tool).
 *
 * The provider holds no mutable state itself — per-session cache state is
 * stored on RunContext.retrievalCache so it survives agent handoffs.
 */

import type {
  KnowledgeProviderConfig,
  AgentKnowledgeOverrides,
  KnowledgeRetrievalResult,
  KnowledgeRetrieverAdapter,
  KnowledgeEmbedderAdapter,
  HarnessStreamPart,
  RetrievalCacheAdapter,
} from '../types/index.js';

// Re-export so existing consumers that import from KnowledgeProvider still work
export type { RetrievalCacheAdapter } from '../types/index.js';

// ---------------------------------------------------------------------------
// Resolved config (after merging agent overrides)
// ---------------------------------------------------------------------------

interface ResolvedKnowledgeConfig {
  compiledEnabled: boolean;
  compiled: string | undefined;
  toolEnabled: boolean;
  topK: number;
  maxOutputTokens: number;
  includeEmbeddings: boolean;
  filter?: Record<string, unknown>;
}

/**
 * Factory function that creates a session-level cache instance.
 * Provided by the integrator so that `@kuralle-agents/core` does not
 * depend on `@kuralle-agents/rag`.
 */
export type RetrievalCacheFactory = () => RetrievalCacheAdapter;

// ---------------------------------------------------------------------------
// KnowledgeProvider
// ---------------------------------------------------------------------------

export interface KnowledgeProviderOptions {
  config: KnowledgeProviderConfig;
  /** Factory for creating per-session cache instances. */
  cacheFactory?: RetrievalCacheFactory;
}

export class KnowledgeProvider {
  private readonly config: KnowledgeProviderConfig;
  private readonly retriever: KnowledgeRetrieverAdapter | undefined;
  private readonly embedder: KnowledgeEmbedderAdapter | undefined;
  private readonly cacheFactory: RetrievalCacheFactory | undefined;

  constructor(options: KnowledgeProviderOptions) {
    this.config = options.config;
    this.retriever = options.config.retriever;
    this.embedder = options.config.embedder;
    this.cacheFactory = options.cacheFactory;
  }

  /**
   * Create a new session-level cache instance. Called once per session
   * in IntakeStage, stored on RunContext.retrievalCache.
   */
  createSessionCache(): RetrievalCacheAdapter | undefined {
    return this.cacheFactory?.();
  }

  /**
   * Resolve effective knowledge config by merging Runtime-level config
   * with per-agent overrides. Agent overrides can only reduce capabilities.
   */
  resolveConfig(agentOverrides?: AgentKnowledgeOverrides): ResolvedKnowledgeConfig {
    const defaults = this.config.defaults ?? {};
    const runtimeTopK = defaults.topK ?? 5;
    const runtimeMaxTokens = defaults.maxOutputTokens ?? 2000;

    return {
      compiledEnabled: agentOverrides?.compiledEnabled ?? true,
      compiled: this.config.compiled,
      toolEnabled: agentOverrides?.toolEnabled ?? true,
      topK: Math.min(agentOverrides?.topK ?? runtimeTopK, runtimeTopK),
      maxOutputTokens: Math.min(
        agentOverrides?.maxOutputTokens ?? runtimeMaxTokens,
        runtimeMaxTokens,
      ),
      includeEmbeddings: defaults.includeEmbeddings ?? true,
      filter: agentOverrides?.filter,
    };
  }

  /**
   * Get compiled knowledge text for system prompt injection (Layer 1).
   * Returns undefined if compiled knowledge is not configured or disabled.
   */
  getCompiledKnowledge(agentOverrides?: AgentKnowledgeOverrides): string | undefined {
    const resolved = this.resolveConfig(agentOverrides);
    if (!resolved.compiledEnabled || !resolved.compiled) return undefined;
    return resolved.compiled;
  }

  /**
   * Run layered retrieval for a user query.
   *
   * Order: cache lookup → hybrid search (on cache miss) → quality check.
   * Results are written back to the cache for future turns.
   *
   * @param query - The user's query text.
   * @param cache - Session-level retrieval cache (may be undefined).
   * @param agentOverrides - Per-agent overrides for knowledge config.
   * @param isVoice - Whether this is a voice agent. Voice agents never
   *   block on reformulation — background reformulation is signalled instead.
   * @returns Results and observability events.
   * @see retrieveWithCitations in `runtime/citations` for the
   *   `SourceRef[]`-bearing envelope used by the citation pipeline.
   */
  async retrieve(
    query: string,
    cache: RetrievalCacheAdapter | undefined,
    agentOverrides?: AgentKnowledgeOverrides,
    isVoice = false,
  ): Promise<{
    results: KnowledgeRetrievalResult[];
    events: HarnessStreamPart[];
  }> {
    const resolved = this.resolveConfig(agentOverrides);
    const events: HarnessStreamPart[] = [];

    if (!this.retriever || !resolved.toolEnabled) {
      return { results: [], events };
    }

    // Layer 2: Cache lookup
    if (cache && this.embedder) {
      const cacheStart = Date.now();
      const queryEmbedding = await this.embedder.embed(query);
      const cached = cache.lookup(queryEmbedding, resolved.topK);
      const cacheLatency = Date.now() - cacheStart;

      if (cached.length > 0) {
        events.push({
          type: 'knowledge-cache-hit',
          query,
          resultCount: cached.length,
          latencyMs: cacheLatency,
        });
        events.push({
          type: 'knowledge-search',
          query,
          resultCount: cached.length,
          latencyMs: cacheLatency,
          layer: 'cache',
        });
        return { results: cached, events };
      }

      events.push({
        type: 'knowledge-cache-miss',
        query,
        latencyMs: cacheLatency,
      });

      // Layer 3: Hybrid search (cache miss)
      const searchStart = Date.now();
      let results = await this.retriever.retrieve(query, {
        topK: resolved.topK,
        filter: resolved.filter,
        queryEmbedding,
        includeEmbeddings: resolved.includeEmbeddings,
      });
      const searchLatency = Date.now() - searchStart;

      events.push({
        type: 'knowledge-search',
        query,
        resultCount: results.length,
        latencyMs: searchLatency,
        layer: 'hybrid',
      });

      // Quality check + optional reformulation
      results = await this.runQualityCheck(query, results, events, isVoice, resolved);

      // Writeback to cache (with query embedding for query-indexed lookup)
      if (results.length > 0) {
        cache.populate(results, queryEmbedding);
      }

      return { results, events };
    }

    // No cache or embedder — direct search
    const searchStart = Date.now();
    let results = await this.retriever.retrieve(query, {
      topK: resolved.topK,
      filter: resolved.filter,
      includeEmbeddings: resolved.includeEmbeddings,
    });
    const searchLatency = Date.now() - searchStart;

    events.push({
      type: 'knowledge-search',
      query,
      resultCount: results.length,
      latencyMs: searchLatency,
      layer: 'hybrid',
    });

    // Quality check + optional reformulation
    results = await this.runQualityCheck(query, results, events, isVoice, resolved);

    return { results, events };
  }

  /**
   * Run quality check on retrieval results and optionally reformulate.
   * Sub-millisecond for the score check; reformulation adds latency only
   * for text agents with low-quality results.
   */
  private async runQualityCheck(
    query: string,
    results: KnowledgeRetrievalResult[],
    events: HarnessStreamPart[],
    isVoice: boolean,
    resolved: ResolvedKnowledgeConfig,
  ): Promise<KnowledgeRetrievalResult[]> {
    const qc = this.config.qualityCheck;
    if (!qc) return results;

    const highThreshold = qc.highThreshold ?? 0.5;
    const mediumThreshold = qc.mediumThreshold ?? 0.3;

    // Score check (sub-millisecond, pure arithmetic)
    const scores = results.map((r) => r.score ?? 0);
    const topScore = scores.length > 0 ? Math.max(...scores) : 0;
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const aboveThreshold = scores.filter((s) => s >= mediumThreshold).length;
    const coverageEstimate = scores.length > 0 ? aboveThreshold / scores.length : 0;

    let quality: 'high' | 'medium' | 'low';
    if (topScore >= highThreshold) {
      quality = 'high';
    } else if (topScore >= mediumThreshold) {
      quality = 'medium';
    } else {
      quality = 'low';
    }

    events.push({
      type: 'knowledge-quality-check',
      query,
      quality,
      topScore,
      avgScore,
      coverageEstimate,
    });

    // Only reformulate on low quality with a reformulate callback
    if (quality !== 'low' || !qc.reformulate) return results;

    if (isVoice) {
      // Voice: signal background reformulation, don't block
      events.push({
        type: 'knowledge-reformulation',
        originalQuery: query,
        reformulatedQuery: '',
        trigger: 'background',
        latencyMs: 0,
      });
      return results;
    }

    // Text: reformulate inline, re-retrieve
    const reformulateStart = Date.now();
    try {
      const reformulatedQuery = await qc.reformulate(query, results);
      const reformulateLatency = Date.now() - reformulateStart;

      events.push({
        type: 'knowledge-reformulation',
        originalQuery: query,
        reformulatedQuery,
        trigger: 'inline',
        latencyMs: reformulateLatency,
      });

      // Re-retrieve with reformulated query (one attempt, no recursion)
      if (this.retriever) {
        const reResults = await this.retriever.retrieve(reformulatedQuery, {
          topK: resolved.topK,
          filter: resolved.filter,
          includeEmbeddings: resolved.includeEmbeddings,
        });
        if (reResults.length > 0) {
          return reResults;
        }
      }
    } catch {
      // Reformulation failed — return original results
    }

    return results;
  }

  /** Whether this provider has a retriever configured. */
  get hasRetriever(): boolean {
    return this.retriever !== undefined;
  }

  /** Whether this provider has compiled knowledge. */
  get hasCompiled(): boolean {
    return this.config.compiled !== undefined && this.config.compiled.length > 0;
  }

  /** Whether predictive pre-fetch is enabled. */
  get prefetchEnabled(): boolean {
    return this.config.prefetch?.enabled ?? false;
  }

  /** Get pre-fetch config. */
  get prefetchConfig(): KnowledgeProviderConfig['prefetch'] {
    return this.config.prefetch;
  }
}
