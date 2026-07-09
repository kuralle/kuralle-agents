import type {
  KnowledgeProviderConfig,
  KnowledgeRetrievalResult,
  KnowledgeRetrieverAdapter,
} from '../../types/voice.js';

export interface InMemoryKnowledgeDocument {
  id?: string;
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

function extractWordsLower(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
}

export function createInMemoryKnowledgeRetriever(
  documents: InMemoryKnowledgeDocument[],
): KnowledgeRetrieverAdapter {
  return {
    retrieve: async (query, options) => {
      const queryWords = extractWordsLower(query);
      if (queryWords.size === 0) {
        return [];
      }

      const topK = options?.topK ?? 5;
      const matches: KnowledgeRetrievalResult[] = [];

      for (const [index, doc] of documents.entries()) {
        const docWords = extractWordsLower(doc.text);
        let matchCount = 0;
        for (const word of queryWords) {
          if (docWords.has(word)) {
            matchCount += 1;
          }
        }
        if (matchCount === 0) {
          continue;
        }
        const score = doc.score ?? matchCount / queryWords.size;
        matches.push({
          id: doc.id ?? `doc-${index}`,
          text: doc.text,
          sourceId: doc.id ?? `doc-${index}`,
          score,
          relevanceScore: score,
          metadata: doc.metadata,
        });
      }

      matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return matches.slice(0, topK);
    },
  };
}

export function createInMemoryKnowledgeConfig(
  documents: InMemoryKnowledgeDocument[],
  overrides: Partial<KnowledgeProviderConfig> = {},
): KnowledgeProviderConfig {
  return {
    retriever: createInMemoryKnowledgeRetriever(documents),
    defaults: {
      topK: 3,
      maxOutputTokens: 500,
      ...overrides.defaults,
    },
    ...overrides,
  };
}
