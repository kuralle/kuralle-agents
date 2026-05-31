import { tool } from 'ai';
import { z } from 'zod';
import type { Retriever, VectorFilter, Reranker } from '@kuralle-agents/rag';

/**
 * Description of a filterable metadata field, provided to the LLM
 * so it knows which fields exist and what values they accept.
 */
export interface FilterableFieldDescriptor {
  /** The metadata field name as stored in the vector index. */
  field: string;
  /** Human-readable description of what this field represents. */
  description: string;
  /** The value type. Helps the LLM construct valid filter values. */
  type: 'string' | 'number' | 'boolean' | 'string[]';
  /** Example values, if useful for guiding the LLM. */
  examples?: (string | number | boolean)[];
}

export interface VectorRetrievalToolOptions {
  /**
   * The retriever to use (VectorRetriever, HybridRetriever, RagPipeline, etc.).
   *
   * Assumptions the caller must satisfy:
   *   - The retriever is already wired to an Embedder + VectorStore pair.
   *   - The retriever's `retrieve(query, { topK, filter })` signature accepts
   *     the MongoDB-style VectorFilter used by Kuralle adapters.
   *   - Any tenant isolation or access control belongs in `staticFilter`, NOT
   *     in retriever internals.
   */
  retriever: Retriever;
  /** Default number of results. Default: 10. */
  topK?: number;
  /** Custom tool description. */
  description?: string;
  /**
   * Enable agentic metadata filtering. When true, the tool schema includes
   * a `filter` parameter that allows the LLM to construct metadata filters
   * dynamically at query time.
   *
   * Default: false.
   */
  enableAgenticFilters?: boolean;
  /**
   * Descriptions of filterable metadata fields. Included in the tool
   * description so the LLM knows which fields exist.
   *
   * Only relevant when enableAgenticFilters is true.
   */
  filterableFields?: FilterableFieldDescriptor[];
  /**
   * A static filter applied to every query, merged with any agentic filter
   * via $and. Use this for tenant isolation or access control.
   */
  staticFilter?: VectorFilter;
  /**
   * Optional reranker applied after the initial retrieve(). When provided,
   * the tool fetches `rerankTopK ?? topK * 3` candidates, then passes them
   * through the reranker and returns the top `topK` reranked results.
   */
  reranker?: Reranker;
  /**
   * How many candidates to pre-fetch when reranking is enabled.
   * Default: `topK * 3`.
   */
  rerankTopK?: number;
}

export interface VectorRetrievalToolOutput {
  results: {
    id: string;
    text: string;
    score?: number;
    sourceId?: string;
    reason?: string;
  }[];
}

export type VectorRetrievalToolInput = {
  query: string;
  topK?: number;
  filter?: Record<string, unknown>;
};

/**
 * Creates a retrieval tool that can be added to any Kuralle agent.
 *
 * The tool wraps any Retriever implementation, allowing the LLM to
 * decide when to search for relevant knowledge. Uses the Vercel AI SDK
 * `tool()` directly.
 */
export function createVectorRetrievalTool(options: VectorRetrievalToolOptions) {
  const {
    retriever,
    topK: defaultTopK = 10,
    enableAgenticFilters = false,
    filterableFields,
    staticFilter,
    reranker,
    rerankTopK,
  } = options;

  let toolDescription =
    options.description ??
    'Search the knowledge base for relevant information. Use this when ' +
    'you need to find specific facts, policies, or context to answer ' +
    'the user\'s question accurately.';

  if (enableAgenticFilters && filterableFields?.length) {
    const fieldDescriptions = filterableFields
      .map(f => {
        let desc = `  - "${f.field}" (${f.type}): ${f.description}`;
        if (f.examples?.length) {
          desc += ` [examples: ${f.examples.map(e => JSON.stringify(e)).join(', ')}]`;
        }
        return desc;
      })
      .join('\n');
    toolDescription +=
      '\n\nYou can optionally filter results by metadata. Available filter fields:\n' +
      fieldDescriptions +
      '\n\nFilter syntax: { "fieldName": "value" } for equality, ' +
      '{ "fieldName": { "$in": ["a", "b"] } } for set membership, ' +
      '{ "fieldName": { "$gt": 5 } } for comparison.';
  }

  const baseParams = {
    query: z.string().describe('The search query to find relevant information.'),
    topK: z
      .number()
      .optional()
      .describe('Number of results to return. Default: ' + defaultTopK),
  };

  const parameters = enableAgenticFilters
    ? z.object({
        ...baseParams,
        filter: z
          .record(z.unknown())
          .optional()
          .describe(
            'Optional metadata filter to narrow results. ' +
            'Use field names from the available filter fields.',
          ),
      })
    : z.object(baseParams);

  return tool({
    description: toolDescription,
    inputSchema: parameters,
    execute: async (
      input: { query: string; topK?: number; filter?: Record<string, unknown> },
    ): Promise<VectorRetrievalToolOutput> => {
      const agenticFilter = input.filter as VectorFilter | undefined;
      let mergedFilter: VectorFilter | undefined;

      if (staticFilter && agenticFilter) {
        mergedFilter = { $and: [staticFilter, agenticFilter] };
      } else {
        mergedFilter = staticFilter ?? agenticFilter;
      }

      const finalTopK = input.topK ?? defaultTopK;
      const fetchTopK = reranker ? (rerankTopK ?? finalTopK * 3) : finalTopK;

      const rawResults = await retriever.retrieve(input.query, {
        topK: fetchTopK,
        filter: mergedFilter,
      });

      const results = reranker
        ? await reranker.rerank(input.query, rawResults, { topK: finalTopK })
        : rawResults;

      return {
        results: results.map(r => ({
          id: r.id,
          text: r.text,
          score: r.score,
          sourceId: r.sourceId,
          reason: r.reason,
        })),
      };
    },
  });
}
