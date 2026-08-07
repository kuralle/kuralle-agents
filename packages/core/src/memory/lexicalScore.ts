/**
 * Crude substring-overlap scorer shared by `preloadMemoryContext` (automatic
 * injection) and `search_memory` (explicit query). One scorer, so the same
 * query against the same string scores the same on both paths — a fact visible
 * in the prompt that cannot be found by searching for it is the drift two
 * separately-maintained copies would produce.
 *
 * The two paths still *select* differently on the same scores, deliberately:
 * preload falls back to showing everything when nothing scores, search returns
 * an empty list. They also score different corpora — preload scores raw facts,
 * search scores flattened `key: value` entries. Shared scoring, not shared
 * behaviour.
 *
 * **This scorer is not a pure extraction from `preloadMemory.ts`.** It added
 * the prefix fallback below, which widens what preload injects — see the
 * changeset. That was a deliberate change, and it is called out here because a
 * reader who assumes "moved, unchanged" will mis-predict preload's output.
 */

export const QUERY_TOKEN_MIN_LENGTH = 4;

/**
 * A token this long sharing a same-length prefix with a word in the text
 * counts as a hit even without an exact substring match — e.g. "allergic"
 * and "allergies" share "allerg". Free-text facts (what `preloadMemoryContext`
 * scores) tend to reuse the asker's own wording, so plain substring matching
 * mostly suffices there. `search_memory` also scores structured field names
 * (a Zod schema key like `allergies`), and a model asking "am I allergic to
 * anything?" reaches for "allergy" or "allergic" — real words one derivational
 * suffix away from "allergies" that substring matching never bridges.
 *
 * Deliberately not a real stemmer: prefix comparison is the whole rule, no
 * suffix tables, no semantic matching. 6 is high enough that short unrelated
 * words never collide ("cats" is below the floor and falls back to plain
 * substring matching; "category" and "catering" need 7 shared characters to
 * fire, which real unrelated words essentially never do by chance).
 */
const PREFIX_MATCH_MIN_LENGTH = 6;

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function tokenHits(token: string, textLower: string, textWords: readonly string[]): boolean {
  if (textLower.includes(token)) return true;
  if (token.length < PREFIX_MATCH_MIN_LENGTH) return false;
  const prefix = token.slice(0, PREFIX_MATCH_MIN_LENGTH);
  return textWords.some((word) => word.startsWith(prefix));
}

/** Fraction of `query`'s tokens (>= QUERY_TOKEN_MIN_LENGTH chars) that appear in `text`, exactly or via a shared long prefix. */
export function lexicalScore(query: string, text: string): number {
  const textLower = text.toLowerCase();
  const textWords = wordsOf(text);
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= QUERY_TOKEN_MIN_LENGTH);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (tokenHits(token, textLower, textWords)) hits += 1;
  }
  return hits / tokens.length;
}
