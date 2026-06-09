import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { Session } from '../types/index.js';
import type { MemoryService } from './MemoryService.js';
import type { MemoryEntry, SearchMemoryRequest, SearchMemoryResponse } from './types.js';
import type { PersistentMemoryStore } from './blocks/types.js';
import { DEFAULT_BLOCK_CHAR_LIMIT } from './blocks/types.js';
import { scanMemoryWrite } from './blocks/safetyScanner.js';

/**
 * Fact-extracting cross-session memory, backed by a `PersistentMemoryStore`
 * block per user (scope `user`, owner = `session.userId`, one fact per line).
 *
 * Unlike the raw-message ingestion path (`extractMemories`), this service
 * runs an LLM merge at ingest: existing facts + the new transcript produce
 * the COMPLETE updated fact list (still-true facts kept, changed ones
 * updated, obsolete ones dropped) — so the block stays small, current, and
 * deduplicated instead of growing append-only.
 *
 * Works on every block backend: file (node), Postgres/Redis adapters, and
 * Cloudflare DO SQLite via `SqlPersistentMemoryStore`.
 */
export interface FactMemoryServiceOptions {
  store: PersistentMemoryStore;
  /** Extractor/merger model, run at temperature 0. */
  model: LanguageModel;
  /** Block key per user. Default: `'FACTS'`. */
  blockKey?: string;
  /** Char limit for the fact block. Default: `DEFAULT_BLOCK_CHAR_LIMIT`. */
  charLimit?: number;
  /** Max facts kept per user. Default: 25. */
  maxFacts?: number;
}

const factsSchema = z.object({
  facts: z.array(z.string()),
});

function parseFactLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line.length > 0);
}

function renderTranscript(session: Session): string {
  const lines: string[] = [];
  for (const message of session.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? (message.content as Array<Record<string, unknown>>)
              .filter((part) => part.type === 'text')
              .map((part) => part.text as string)
              .join('\n')
          : '';
    if (content.trim()) {
      lines.push(`${message.role}: ${content}`);
    }
  }
  return lines.join('\n');
}

const QUERY_TOKEN_MIN_LENGTH = 4;

function lexicalScore(query: string, fact: string): number {
  const factLower = fact.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= QUERY_TOKEN_MIN_LENGTH);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (factLower.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

export function createFactMemoryService(options: FactMemoryServiceOptions): MemoryService {
  const blockKey = options.blockKey ?? 'FACTS';
  const charLimit = options.charLimit ?? DEFAULT_BLOCK_CHAR_LIMIT;
  const maxFacts = options.maxFacts ?? 25;

  return {
    async addSessionToMemory(session: Session): Promise<void> {
      if (!session.userId) return;
      const transcript = renderTranscript(session);
      if (!transcript.trim()) return;

      try {
        const existing = await options.store.loadBlock('user', session.userId, blockKey);
        const existingFacts = existing ? parseFactLines(existing.content) : [];

        const { object } = await generateObject({
          model: options.model,
          schema: factsSchema,
          temperature: 0,
          system: [
            'You maintain the long-term memory of a customer-facing assistant.',
            'From the EXISTING FACTS and the NEW CONVERSATION, produce the complete updated fact list about this user.',
            'Keep facts that are still true, update ones that changed, drop obsolete or duplicate ones.',
            'Only durable facts worth remembering across conversations: stable preferences, profile details',
            '(name, address, sizes), recurring context (orders they reference, their business).',
            'Exclude one-off details, small talk, and sensitive payment data (card numbers, passwords).',
            `At most ${maxFacts} facts, each a single self-contained sentence under 200 characters.`,
          ].join('\n'),
          prompt: [
            `EXISTING FACTS:\n${existingFacts.length > 0 ? existingFacts.map((f) => `- ${f}`).join('\n') : '(none)'}`,
            `NEW CONVERSATION:\n${transcript}`,
          ].join('\n\n'),
        });

        const safeFacts = object.facts
          .map((fact) => fact.trim())
          .filter((fact) => fact.length > 0 && scanMemoryWrite(fact).safe)
          .slice(0, maxFacts);

        let content = safeFacts.map((fact) => `- ${fact}`).join('\n');
        while (content.length > charLimit && safeFacts.length > 0) {
          safeFacts.pop();
          content = safeFacts.map((fact) => `- ${fact}`).join('\n');
        }

        await options.store.saveBlock(
          {
            key: blockKey,
            scope: 'user',
            content,
            charLimit,
            updatedAt: new Date().toISOString(),
          },
          session.userId,
        );
      } catch (error) {
        // Memory must never take down a turn — ingest failures are logged, not thrown.
        console.warn(
          `[Kuralle] fact-memory ingest failed for user ${session.userId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    },

    async searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse> {
      const block = await options.store.loadBlock('user', request.userId, blockKey);
      if (!block) {
        return { memories: [] };
      }
      const facts = parseFactLines(block.content);
      const createdAt = block.updatedAt ? new Date(block.updatedAt) : new Date();
      const limit = request.limit ?? 10;

      const scored = facts.map((fact, index) => ({
        fact,
        index,
        score: lexicalScore(request.query, fact),
      }));
      const relevant = scored.filter((entry) => entry.score > 0);
      // Facts are few and curated: when nothing matches lexically, return them
      // all (up to limit) — continuity beats false-negative emptiness.
      const selected = (relevant.length > 0 ? relevant.sort((a, b) => b.score - a.score) : scored)
        .slice(0, limit);

      return {
        memories: selected.map(
          (entry): MemoryEntry => ({
            id: `${request.userId}:${blockKey}:${entry.index}`,
            sessionId: 'fact-memory',
            userId: request.userId,
            content: entry.fact,
            author: 'memory',
            createdAt,
            score: entry.score,
          }),
        ),
      };
    },

    async deleteMemories(userId: string): Promise<void> {
      await options.store.deleteBlock('user', userId, blockKey);
    },
  };
}
