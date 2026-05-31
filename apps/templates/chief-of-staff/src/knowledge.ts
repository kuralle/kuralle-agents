import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeProviderConfig } from '@kuralle-agents/core';

const dir = dirname(fileURLToPath(import.meta.url));
const kbDir = join(dir, '..', 'knowledge');
export const compiledKnowledge = readdirSync(kbDir).filter((f) => f.endsWith('.md')).map((f) => {
	const body = readFileSync(join(kbDir, f), 'utf8');
	const heading = f.replace(/\.md$/, '').replace(/-/g, ' ');
	return `## ${heading}\n\n${body}`;
}).join('\n\n---\n\n');

export const knowledgeConfig: KnowledgeProviderConfig = {
	compiled: compiledKnowledge,
	defaults: { topK: 0, maxOutputTokens: 6000 },
};
