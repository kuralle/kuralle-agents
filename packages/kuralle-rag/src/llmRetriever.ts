import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { KnowledgeRetriever, KnowledgeSource, LLMRetrieverOptions, RetrievalHit } from './types.js';

const outputSchema = z.object({
  ranked: z.array(
    z.object({
      sourceId: z.string(),
      chunkId: z.string(),
      reason: z.string(),
    })
  ),
});

export function createLLMRetriever(options: LLMRetrieverOptions): KnowledgeRetriever {
  const { model, topK = 4, includeReasons = true, candidateMaxChars = 1500 } = options;

  return {
    async retrieve(query: string, sources: KnowledgeSource[], opts?: { topK?: number; hint?: string }): Promise<RetrievalHit[]> {
      const k = Math.max(1, opts?.topK ?? topK);
      const candidates = flattenCandidates(sources);
      if (candidates.length === 0) return [];

      const prompt = buildPrompt({
        query,
        hint: opts?.hint,
        candidates,
        candidateMaxChars,
        topK: k,
      });

      const { output } = await generateText({
        model,
        system: 'You are a retrieval ranker. Only select from provided chunk IDs.',
        prompt,
        output: Output.object({ schema: outputSchema }),
      });

      const ranked = output.ranked ?? [];
      return coerceHits(ranked, candidates, k, includeReasons);
    },
  };
}

function flattenCandidates(sources: KnowledgeSource[]) {
  const candidates: Array<{ sourceId: string; chunkId: string; text: string; sourceName: string }> = [];
  for (const source of sources) {
    const chunks = source.getChunks();
    for (const chunk of chunks) {
      candidates.push({
        sourceId: source.id,
        chunkId: chunk.id,
        text: chunk.text,
        sourceName: source.name,
      });
    }
  }
  return candidates;
}

function buildPrompt(input: {
  query: string;
  hint?: string;
  candidates: Array<{ sourceId: string; chunkId: string; text: string; sourceName: string }>;
  candidateMaxChars: number;
  topK: number;
}): string {
  const header = [
    `Query: ${input.query}`,
    input.hint ? `Hint: ${input.hint}` : null,
    `Return top ${input.topK} chunk IDs with short reasons.`,
    'Only use provided sourceId + chunkId pairs.',
  ]
    .filter(Boolean)
    .join('\n');

  const chunks = input.candidates
    .map(candidate => {
      const body = candidate.text.slice(0, input.candidateMaxChars);
      return `sourceId: ${candidate.sourceId}\nchunkId: ${candidate.chunkId}\nsourceName: ${candidate.sourceName}\n${body}`;
    })
    .join('\n\n---\n\n');

  return `${header}\n\nChunks:\n${chunks}`;
}

function coerceHits(
  ranked: Array<{ sourceId: string; chunkId: string; reason?: string }>,
  candidates: Array<{ sourceId: string; chunkId: string }>,
  topK: number,
  includeReasons: boolean
): RetrievalHit[] {
  const candidateSet = new Set(candidates.map(c => `${c.sourceId}::${c.chunkId}`));
  const hits: RetrievalHit[] = [];

  for (const entry of ranked) {
    const key = `${entry.sourceId}::${entry.chunkId}`;
    if (!candidateSet.has(key)) continue;
    if (hits.find(hit => hit.sourceId === entry.sourceId && hit.chunkId === entry.chunkId)) continue;

    hits.push({
      sourceId: entry.sourceId,
      chunkId: entry.chunkId,
      rank: hits.length + 1,
      reason: includeReasons ? entry.reason ?? '' : undefined,
    });

    if (hits.length >= topK) break;
  }

  return hits;
}
