import { describe, expect, it } from 'bun:test';
import { normalizeCitations, retrieveWithCitations, type CitationRetrievalProvider } from '../src/runtime/citations/index.ts';

describe('native citations', () => {
  it("native retriever's citations are deduplicated and ordered by score", async () => {
    const provider: CitationRetrievalProvider = {
      async retrieve() {
        return {
          results: [],
          citations: [
            { id: 'source-low', title: 'Low', score: 0.2 },
            { id: 'source-high', title: 'High', score: 0.9 },
            { id: 'source-low', title: 'Low duplicate', score: 0.7 },
          ],
          events: [],
        };
      },
    };

    const result = await retrieveWithCitations(provider, 'policy', undefined);

    expect(result.citations).toEqual([
      { id: 'source-high', title: 'High', score: 0.9 },
      { id: 'source-low', title: 'Low duplicate', score: 0.7 },
    ]);
  });

  it('native empty citations fall back to synthesized result citations', () => {
    const citations = normalizeCitations(
      [{ id: 'chunk-1', text: 'A', sourceId: 'source-a', score: 0.5 }],
      [],
    );

    expect(citations).toEqual([{ id: 'source-a', score: 0.5 }]);
  });
});
