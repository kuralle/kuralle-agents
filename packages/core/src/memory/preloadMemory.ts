import type { Session } from '../types/index.js';
import type { MemoryService } from './MemoryService.js';

/**
 * Token estimation function. Matches the estimator used in ContextManager.ts:
 * Math.ceil(text.length / 4).
 */
function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Preloads relevant memories into the system prompt before each LLM call.
 *
 * This is NOT a tool the LLM calls. It is a Runtime-level middleware that:
 * 1. Takes the user's latest message as a search query
 * 2. Searches long-term memory for relevant context
 * 3. Formats matching memories as a markdown section
 * 4. Truncates the output to fit within the allocated token budget
 *
 * The maxTokens parameter is mandatory. If the formatted output exceeds
 * maxTokens, memories are dropped in lowest-relevance-first order until
 * the output fits.
 */
export async function preloadMemoryContext(
  memoryService: MemoryService,
  session: Session,
  userInput: string,
  maxTokens: number,
): Promise<string | null> {
  if (!session.userId) return null;
  if (maxTokens <= 0) return null;

  const result = await memoryService.searchMemory({
    userId: session.userId,
    query: userInput,
    limit: 10,
  });

  if (result.memories.length === 0) return null;

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

  for (const m of result.memories) {
    const author = m.author ? `${m.author}: ` : '';
    const date = m.createdAt
      ? `[${m.createdAt.toISOString().split('T')[0]}] `
      : '';
    const line = `${date}${author}${m.content}`;
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
