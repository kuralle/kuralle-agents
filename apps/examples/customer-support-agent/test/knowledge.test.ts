import { describe, expect, it } from 'bun:test';
import { supportConfig } from '../support.config.js';
import { createSupportKnowledge } from '../src/knowledge.js';

describe('portable support retrieval', () => {
  it('ranks customer policy without an embedding service and preserves citations', async () => {
    const knowledge = createSupportKnowledge(supportConfig);
    const results = await knowledge.retriever!.retrieve('Where is my invoice and when does annual billing renew?', { topK: 2 });
    expect(results[0]?.id).toBe('plans-and-billing');
    expect(results[0]?.metadata).toMatchObject({
      title: 'Plans and billing',
      url: 'https://docs.example.com/billing/plans',
    });
    expect(knowledge.embedder).toBeUndefined();
    expect(knowledge.defaults?.includeEmbeddings).toBe(false);
  });
});
