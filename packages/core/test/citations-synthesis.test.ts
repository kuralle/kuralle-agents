import { describe, expect, it } from 'bun:test';
import { normalizeCitations, retrieveWithCitations, type CitationRetrievalProvider } from '../src/runtime/citations/index.ts';
import type { KnowledgeRetrievalResult } from '../src/types/index.ts';

describe('citation synthesis', () => {
  it('legacy retriever results get synthesized SourceRefs deduplicated by sourceId', async () => {
    const provider: CitationRetrievalProvider = {
      async retrieve() {
        return {
          results: [
            chunk({ id: 'a1', sourceId: 'article-a', score: 0.4 }),
            chunk({ id: 'a2', sourceId: 'article-a', score: 0.8 }),
            chunk({ id: 'b1', sourceId: 'article-b', score: 0.6, title: 'Article B' }),
          ],
          events: [],
        };
      },
    };

    const result = await retrieveWithCitations(provider, 'refund policy', undefined);

    expect(result.citations).toEqual([
      { id: 'article-a', score: 0.8 },
      { id: 'article-b', title: 'Article B', score: 0.6 },
    ]);
  });

  it('legacy chunks without sourceId receive synthetic ids', () => {
    const citations = normalizeCitations([
      { id: 'legacy-1', text: 'same source text' } as KnowledgeRetrievalResult,
    ]);

    expect(citations).toHaveLength(1);
    expect(citations[0].id).toMatch(/^synthetic-[a-f0-9]{12}$/);
  });
});

function chunk(input: {
  id: string;
  sourceId: string;
  score: number;
  title?: string;
}): KnowledgeRetrievalResult {
  return {
    id: input.id,
    text: `${input.sourceId} content`,
    sourceId: input.sourceId,
    score: input.score,
    relevanceScore: input.score,
    metadata: input.title ? { title: input.title } : undefined,
  };
}
