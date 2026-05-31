import { describe, it, expect } from 'bun:test';
import { createStaticKnowledgeSource } from '@kuralle-agents/rag';
import type { KnowledgeRetriever } from '@kuralle-agents/rag';
import {
  createCagTool,
  createCagAnswerTool,
  createVectorRetrievalTool,
} from '../src/index.js';

const stubRetriever: KnowledgeRetriever = {
  async retrieve(query, sources, opts) {
    const topK = opts?.topK ?? 2;
    const hits = [];
    for (const source of sources) {
      for (const chunk of source.getChunks().slice(0, topK)) {
        hits.push({
          sourceId: source.id,
          chunkId: chunk.id,
          rank: hits.length + 1,
          score: 1,
          reason: `matched ${query}`,
        });
      }
    }
    return hits;
  },
};

describe('@kuralle-agents/tools public exports', () => {
  it('createCagTool retrieves chunks from static sources (offline)', async () => {
    const source = createStaticKnowledgeSource({
      id: 'menu',
      name: 'Menu',
      content: '# Pizza\nMargherita $12\n# Pasta\nPenne $14',
    });

    const tool = createCagTool({
      sources: [source],
      retriever: stubRetriever,
      topK: 2,
    });

    expect(typeof tool.execute).toBe('function');
    const out = await tool.execute!({ query: 'pizza price' });
    expect(out.chunks.length).toBeGreaterThan(0);
    expect(out.chunks[0]?.text.length).toBeGreaterThan(0);
  });

  it('createCagAnswerTool and createVectorRetrievalTool are exported factories', () => {
    expect(typeof createCagAnswerTool).toBe('function');
    expect(typeof createVectorRetrievalTool).toBe('function');
  });
});
