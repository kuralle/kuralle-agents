/**
 * The LLM-facing `search_memory` tool — the explicit-query half of the memory
 * read surface. `preloadMemoryContext` is the other half: automatic,
 * facts-only, injected every turn. This tool is model-initiated and reaches
 * every extractor the agent declares, not just `facts`.
 *
 * Mirrors `memoryBlockTool.ts`'s addressing pattern exactly: the model's
 * `slug` argument is a `z.enum` built from the extractors the agent declares,
 * so an undeclared slug is not rejected at runtime, it cannot be expressed.
 * `ExtractedValueStore` has no `list()` (deliberately — enumerating every
 * value for an owner is exactly what a leak looks like), and the enum is what
 * makes that unnecessary: this tool loads exactly the declared slugs and
 * never asks the store what else is there.
 */
import { z } from 'zod';
import { tool } from 'ai';
import type { AiSdkTool } from '../../tools/Tool.js';
import { lexicalScore } from '../lexicalScore.js';
import type { MemoryBlockScope } from '../blocks/types.js';
import type { ExtractedValueStore } from './store.js';
import type { AnyResolvedExtractor } from './types.js';

export interface SearchMemoryToolOptions {
  store: ExtractedValueStore;
  /** The extractors this agent declares. The model can search these and nothing else.
   *  Heterogeneous — see `AnyResolvedExtractor`. */
  extractors: AnyResolvedExtractor[];
  /** Owner for a scope, or undefined when this session has none.
   *  There is deliberately no placeholder — see `resolveWorkingMemoryOwner`. */
  resolveOwner: (scope: MemoryBlockScope) => string | undefined;
  /** Max entries returned. Default 10, matching preloadMemoryContext. */
  limit?: number;
}

const DEFAULT_LIMIT = 10;

/**
 * Reduces a stored extracted value to the lexically-scorable strings inside it.
 *
 * - **Bare string array** → its items verbatim.
 * - **Object** → one entry per top-level key. A string-array field spreads to
 *   one `key: item` entry per item, not one combined blob.
 * - **Bare scalar** (string, number, boolean) → one entry. A schema of
 *   `z.string()` is legal for an extractor, and without this it flattened to
 *   nothing — stored, and permanently unsearchable.
 * - Anything else under a key → one `key: JSON.stringify(value)` line.
 *
 * The key prefix earns its place beyond labelling: a field like
 * `allergies: string[]` may hold bare allergen names ("shellfish") with no word
 * relating them to "allergy" at all, so the field name is often the only text
 * in the corpus a query about the concept can match.
 *
 * Note the built-in facts extractor stores `{ facts: string[] }` — an object,
 * not a bare array — so it takes the object branch and search sees
 * `facts: <item>` where preload sees `<item>`. Same items, same order, one
 * extra prefix on the search side; the scores can therefore differ slightly
 * between the two paths on the same slug.
 */
function flattenExtractedValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (value && typeof value === 'object') {
    const entries: string[] = [];
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(val) && val.every((item) => typeof item === 'string')) {
        for (const item of val as string[]) {
          entries.push(`${key}: ${item}`);
        }
      } else {
        entries.push(`${key}: ${JSON.stringify(val)}`);
      }
    }
    return entries;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  return [];
}

function buildInputSchema(slugs: [string, ...string[]]) {
  return z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'What to look for in stored memory about this user. Matching is literal, so prefer the ' +
          "wording used in the target memory's own description over paraphrasing.",
      ),
    slug: z
      .enum(slugs)
      .optional()
      .describe('Which memory to search. Omit to search all of them.'),
  });
}

/** One line per declared extractor, in its own words — the vocabulary a query is most likely to match. */
function describeExtractors(extractors: readonly AnyResolvedExtractor[]): string {
  return extractors.map((e) => `- ${e.slug} (${e.name}): ${e.instructions}`).join('\n');
}

type Input = z.infer<ReturnType<typeof buildInputSchema>>;

interface SearchMemoryResult {
  slug: string;
  entry: string;
  score: number;
}

export function buildSearchMemoryTool(
  options: SearchMemoryToolOptions,
): AiSdkTool<Input, { results: SearchMemoryResult[] }> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  // One entry per slug. `validateExtractorList` already rejects a duplicate
  // slug at agent-config time, so this map is never lossy in practice.
  const bySlug = new Map<string, AnyResolvedExtractor>();
  for (const extractor of options.extractors) {
    bySlug.set(extractor.slug, extractor);
  }
  if (bySlug.size === 0) {
    throw new Error('[Kuralle] buildSearchMemoryTool requires at least one declared extractor.');
  }
  const slugs = [...bySlug.keys()] as [string, ...string[]];

  return tool({
    // Deliberately short. An earlier revision carried a ~200-token procedure
    // telling the model to retry with different wording before concluding
    // anything was unstored — a prompt mitigation for the fact that matching is
    // lexical, paid on every turn the tool is visible whether or not it is
    // called. This repo's rule is to enforce at the tool boundary rather than
    // ask the model to remember something, and the real answer to "a query has
    // to share words with the entry" is a semantic index, not a longer
    // description. That is filed; this states the limitation once and stops.
    description:
      "Search this user's stored memory — profile data extracted from past conversations that is " +
      'not automatically shown in context. Matching is literal, not semantic: a query has to share ' +
      'words with the stored entry, so an empty result means this query matched nothing, not that ' +
      `the memory is absent.\n\nAvailable memories:\n${describeExtractors(options.extractors)}`,
    inputSchema: buildInputSchema(slugs),
    async execute(input: Input) {
      const targets = input.slug ? [bySlug.get(input.slug)!] : [...bySlug.values()];
      const results: SearchMemoryResult[] = [];

      for (const extractor of targets) {
        const owner = options.resolveOwner(extractor.scope);
        if (owner === undefined) {
          // Never fall back to a placeholder owner — see the store's own doc.
          continue;
        }
        const row = await options.store.load(extractor.scope, owner, extractor.slug);
        if (!row) continue;

        for (const entry of flattenExtractedValue(row.value)) {
          const score = lexicalScore(input.query, entry);
          if (score > 0) {
            results.push({ slug: extractor.slug, entry, score });
          }
        }
      }

      // Deliberate divergence from `preloadMemoryContext`, which returns
      // everything when nothing scores (continuity beats a false negative for
      // automatic injection). An explicit question deserves an honest "nothing
      // found" instead of unrelated entries — do not "fix" this to match.
      results.sort((a, b) => b.score - a.score);
      return { results: results.slice(0, limit) };
    },
  });
}
