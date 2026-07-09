import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type {
  Reranker,
  RetrievalResult,
  RerankerOptions,
} from '../types.js';

export interface LLMRerankerOptions {
  /** The language model to use for scoring. */
  model: LanguageModel;
  /** Maximum number of results to return after reranking. Default: 5. */
  topK?: number;
  /** Whether to include the LLM's reasoning in results. Default: true. */
  includeReasons?: boolean;
  /** Maximum characters of document text to include per candidate. Default: 1500. */
  candidateMaxChars?: number;
}

const scoringSchema = z.object({
  scored: z.array(
    z.object({
      id: z.string(),
      score: z.number().min(0).max(10),
      reason: z.string().optional(),
    }),
  ),
});

/**
 * Reranker that uses a language model to judge relevance.
 *
 * Each candidate document is presented to the LLM alongside the query.
 * The LLM scores each candidate on a 0-10 scale and optionally provides
 * a reason for the score. Results are reordered by LLM-assigned score.
 */
export class LLMReranker implements Reranker {
  private readonly model: LanguageModel;
  private readonly defaultTopK: number;
  private readonly includeReasons: boolean;
  private readonly candidateMaxChars: number;

  constructor(options: LLMRerankerOptions) {
    this.model = options.model;
    this.defaultTopK = options.topK ?? 5;
    this.includeReasons = options.includeReasons ?? true;
    this.candidateMaxChars = options.candidateMaxChars ?? 1500;
  }

  async rerank(
    query: string,
    results: RetrievalResult[],
    options?: RerankerOptions,
  ): Promise<RetrievalResult[]> {
    const topK = options?.topK ?? this.defaultTopK;

    if (results.length === 0) return [];

    const candidateBlock = results
      .map(
        (r, i) =>
          `[${i}] ID: ${r.id}\n` +
          `Text: ${r.text.slice(0, this.candidateMaxChars)}`,
      )
      .join('\n\n');

    const systemPrompt =
      'You are a relevance judge. You will be given a query and a list of ' +
      'candidate documents. Score each document from 0 (completely irrelevant) ' +
      'to 10 (perfectly relevant) based on how well it answers the query. ' +
      'Only use candidate IDs from the provided list. Return ALL candidates scored.';

    const userPrompt =
      `Query: ${query}\n\n` +
      `Candidates:\n${candidateBlock}`;

    const { experimental_output } = await generateText({
      model: this.model,
      system: systemPrompt,
      prompt: userPrompt,
      experimental_output: Output.object({ schema: scoringSchema }),
    });

    if (!experimental_output) return results.slice(0, topK);

    const scoreMap = new Map<string, { score: number; reason?: string }>();
    for (const scored of experimental_output.scored) {
      scoreMap.set(scored.id, {
        score: scored.score,
        reason: scored.reason,
      });
    }

    const reranked: RetrievalResult[] = results
      .map(r => {
        const llmScore = scoreMap.get(r.id);
        return {
          ...r,
          score: llmScore ? llmScore.score / 10 : 0,
          relevanceScore: llmScore ? llmScore.score / 10 : 0,
          reason: this.includeReasons ? llmScore?.reason : undefined,
        };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return reranked.slice(0, topK);
  }
}
