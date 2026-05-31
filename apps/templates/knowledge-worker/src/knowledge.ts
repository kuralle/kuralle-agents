import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeProviderConfig, KnowledgeRetrievalResult } from '@kuralle-agents/core';

const dir = dirname(fileURLToPath(import.meta.url));
const kbDir = join(dir, '..', 'knowledge');

const documents = readdirSync(kbDir).filter((f) => f.endsWith('.md')).map((f) => {
	const body = readFileSync(join(kbDir, f), 'utf8');
	const heading = f.replace(/\.md$/, '').replace(/-/g, ' ');
	return {
		id: f.replace(/\.md$/, ''),
		title: heading,
		body,
		compiled: `## ${heading}\n\n${body}`,
	};
});

export const compiledKnowledge = documents.map((doc) => doc.compiled).join('\n\n---\n\n');

export const knowledgeConfig: KnowledgeProviderConfig = {
	compiled: compiledKnowledge,
	retriever: {
		async retrieve(query, options): Promise<KnowledgeRetrievalResult[]> {
			const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
			const scored = documents
				.map((doc) => {
					const haystack = `${doc.title}\n${doc.body}`.toLowerCase();
					const matches = terms.filter((term) => haystack.includes(term)).length;
					return { doc, score: terms.length > 0 ? matches / terms.length : 0 };
				})
				.filter((item) => item.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, options?.topK ?? 3);

			return scored.map(({ doc, score }) => ({
				id: doc.id,
				text: doc.compiled,
				sourceId: doc.id,
				score,
				relevanceScore: score,
				snippet: doc.body.slice(0, 240),
				metadata: { title: doc.title },
			}));
		},
	},
	defaults: { topK: 3, maxOutputTokens: 4000 },
};
