/**
 * Hearth-bot knowledge — refund matrix + cancellation/box-issue policies.
 * Small enough (single .md) to inject as L1 compiled into every agent.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeProviderConfig } from '@kuralle-agents/core';

const dir = dirname(fileURLToPath(import.meta.url));
const policies = readFileSync(join(dir, '..', 'knowledge', 'policies.md'), 'utf8');

export const compiledKnowledge = `## Hearth Policies\n\n${policies}`;

export const knowledgeConfig: KnowledgeProviderConfig = {
	compiled: compiledKnowledge,
	defaults: { topK: 0, maxOutputTokens: 4000 },
};
