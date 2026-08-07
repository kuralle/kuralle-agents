import type { Session } from '../types/index.js';
import type { ExtractedValueStore } from './extract/store.js';
import { FACTS_EXTRACTOR_SLUG } from './extract/builtin/factsExtractor.js';
import { lexicalScore } from './lexicalScore.js';

/**
 * Token estimation function. Matches the estimator used in ContextManager.ts:
 * Math.ceil(text.length / 4).
 */
function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Preloads relevant extracted facts into the system prompt before each LLM call.
 *
 * This is NOT a tool the LLM calls. It is a Runtime-level middleware that:
 * 1. Takes the user's latest message as a search query
 * 2. Loads cross-session facts from `ExtractedValueStore` (slug `facts`)
 * 3. Formats matching facts as a markdown section
 * 4. Truncates the output to fit within the allocated token budget
 *
 * The maxTokens parameter is mandatory. If the formatted output exceeds
 * maxTokens, memories are dropped in lowest-relevance-first order until
 * the output fits.
 */
export async function preloadMemoryContext(
  store: ExtractedValueStore,
  session: Session,
  userInput: string,
  maxTokens: number,
): Promise<string | null> {
  if (!session.userId) return null;
  if (maxTokens <= 0) return null;

  const loaded = await store.load('user', session.userId, FACTS_EXTRACTOR_SLUG);
  if (!loaded) return null;

  const facts = (loaded.value as { facts?: string[] }).facts ?? [];
  if (facts.length === 0) return null;

  const createdAt = loaded.updatedAt ? new Date(loaded.updatedAt) : new Date();
  const limit = 10;

  const scored = facts.map((fact, index) => ({
    fact,
    index,
    score: lexicalScore(userInput, fact),
  }));
  const relevant = scored.filter((entry) => entry.score > 0);
  // Facts are few and curated: when nothing matches lexically, return them
  // all (up to limit) — continuity beats false-negative emptiness.
  const selected = (relevant.length > 0 ? relevant.sort((a, b) => b.score - a.score) : scored).slice(
    0,
    limit,
  );

  const headerLines = [
    '## Context from Past Conversations',
    '',
    'The following is from previous conversations with this user.',
    'Use this context to provide continuity and avoid asking for information the user has already provided.',
    '',
  ];
  const header = headerLines.join('\n');
  let estimatedTokens = estimateTokenCount(header);

  const includedLines: string[] = [];

  for (const entry of selected) {
    const date = createdAt ? `[${createdAt.toISOString().split('T')[0]}] ` : '';
    const line = `${date}memory: ${entry.fact}`;
    const lineTokens = estimateTokenCount(line);

    if (estimatedTokens + lineTokens > maxTokens) {
      break;
    }

    includedLines.push(line);
    estimatedTokens += lineTokens;
  }

  if (includedLines.length === 0) return null;

  return header + includedLines.join('\n');
}
