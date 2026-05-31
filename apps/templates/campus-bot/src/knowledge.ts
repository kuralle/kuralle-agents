/**
 * Knowledge loader. Three small markdown files concatenated into a
 * single compiled-knowledge string injected into every agent's system
 * prompt every turn (no retrieval needed — KB is small).
 *
 * Production swap path: when the KB grows past ~2k tokens, switch to a
 * proper retriever (BM25 or vector). The agent-level
 * `{compiledEnabled, toolEnabled, topK}` lets each agent pick its mix.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeProviderConfig } from '@kuralle-agents/core';

const dir = dirname(fileURLToPath(import.meta.url));
const knowledgeDir = join(dir, '..', 'knowledge');

function load(file: string, heading: string): string {
	const body = readFileSync(join(knowledgeDir, file), 'utf8');
	return `## ${heading}\n\n${body}`;
}

export const compiledKnowledge = [
	load('academic-policies.md', 'Academic Policies'),
	load('financial-aid.md', 'Financial Aid Policies'),
	load('wellbeing-resources.md', 'Wellbeing Resources'),
].join('\n\n---\n\n');

export const knowledgeConfig: KnowledgeProviderConfig = {
	compiled: compiledKnowledge,
	defaults: {
		topK: 0,
		maxOutputTokens: 4000,
	},
};
