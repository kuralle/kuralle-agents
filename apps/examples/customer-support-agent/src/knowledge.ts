import type { KnowledgeProviderConfig, KnowledgeRetrievalResult } from '@kuralle-agents/core';
import { BM25Index } from '@kuralle-agents/rag';
import type { SupportTemplateConfig } from './config';

/**
 * Zero-service retrieval for the swap-in corpus. BM25 is built once per runtime
 * instance and works unchanged in Node and Workers. Larger installations can
 * replace only this adapter with Vectorize, pgvector, or another retriever.
 */
export function createSupportKnowledge(config: SupportTemplateConfig): KnowledgeProviderConfig {
  const index = new BM25Index();
  const byId = new Map(config.knowledge.map((article) => [article.id, article]));
  index.add(config.knowledge.map((article) => ({
    id: article.id,
    text: `${article.title}\n${article.tags.join(' ')}\n${article.body}`,
  })));

  return {
    retriever: {
      async retrieve(query, options) {
        const hits = index.search(query, options?.topK ?? 4);
        return hits.flatMap<KnowledgeRetrievalResult>((hit) => {
          const article = byId.get(hit.id);
          if (!article) return [];
          return [{
            id: article.id,
            sourceId: article.id,
            text: `${article.title}\n\n${article.body}`,
            score: hit.score,
            relevanceScore: hit.score,
            metadata: {
              title: article.title,
              ...(article.url ? { url: article.url } : {}),
              ...(article.lastModified ? { lastModified: article.lastModified } : {}),
              tags: article.tags,
            },
          }];
        });
      },
    },
    defaults: {
      topK: 4,
      maxOutputTokens: 1_200,
      includeEmbeddings: false,
    },
    renderCitations: 'footnotes',
  };
}
