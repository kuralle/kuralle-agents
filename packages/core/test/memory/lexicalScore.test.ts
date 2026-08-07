import { describe, expect, it } from 'bun:test';
import { lexicalScore, QUERY_TOKEN_MIN_LENGTH } from '../../src/memory/lexicalScore.ts';

describe('lexicalScore', () => {
  it('scores 1 when every query token is a literal substring of the text', () => {
    expect(lexicalScore('favorite color blue', 'My favorite color is blue')).toBe(1);
  });

  it('scores 0 when no query token appears in the text', () => {
    expect(lexicalScore('pizza toppings', 'My favorite color is blue')).toBe(0);
  });

  it('scores partial credit as the fraction of tokens that hit', () => {
    // 'favorite' hits, 'pizza' does not — 1 of 2 tokens.
    expect(lexicalScore('favorite pizza', 'My favorite color is blue')).toBe(0.5);
  });

  it('drops tokens shorter than QUERY_TOKEN_MIN_LENGTH entirely', () => {
    expect(QUERY_TOKEN_MIN_LENGTH).toBe(4);
    // 'is' (2 chars) is dropped; only 'blue' (4 chars) counts, and it hits.
    expect(lexicalScore('is blue', 'My favorite color is blue')).toBe(1);
    // With every token below the floor, there is nothing left to score.
    expect(lexicalScore('is a', 'My favorite color is blue')).toBe(0);
  });

  it('bridges a plural/singular mismatch via shared prefix', () => {
    // 'allergy' (singular) vs a fact stored under the plural field name
    // 'allergies' — the exact case `search_memory` hits against a Zod schema
    // field, where the value itself never contains the word "allergy" at all.
    expect(lexicalScore('allergy', 'allergies: ["shellfish"]')).toBeGreaterThan(0);
    expect(lexicalScore('allergies', 'my allergy is real')).toBeGreaterThan(0);
  });

  it('bridges a derivational form (adjective vs noun) via shared prefix', () => {
    // "allergic" shares no substring relationship with "allergies" at all —
    // only the prefix bridge catches this, which is the whole reason it exists.
    expect(lexicalScore('allergic', 'allergies: ["shellfish"]')).toBeGreaterThan(0);
  });

  it('does not bridge short tokens below the prefix-match floor', () => {
    // 'cats' is 4 chars — below PREFIX_MATCH_MIN_LENGTH (6) — so it falls back
    // to plain substring matching and must not fuzzy-match 'category'.
    expect(lexicalScore('cats', 'category theory is hard')).toBe(0);
  });

  it('does not turn into a fuzzy matcher for unrelated long words', () => {
    expect(lexicalScore('allergy', 'the algorithm converged')).toBe(0);
  });
});

/**
 * The prefix fallback is NOT a pure extraction from preloadMemory.ts — it widens
 * what preload injects. A cross-family review found it undisclosed; these tests
 * pin it so it is a decided behaviour rather than an accident, and so a future
 * "simplification" back to substring-only fails here instead of silently
 * changing every agent's prompt.
 */
describe('the prefix fallback changes preload membership, on purpose', () => {
  it('scores a derivational pair that substring matching cannot bridge', () => {
    // The exact pair that motivated it: a field name `allergies`, a query "allergic".
    expect(lexicalScore('allergic', 'allergies: shellfish')).toBeGreaterThan(0);
    // Substring alone scores zero here — that is the whole delta.
    expect('allergies: shellfish'.includes('allergic')).toBe(false);
  });

  it('keeps every match the substring-only scorer made', () => {
    expect(lexicalScore('shellfish', 'allergies: shellfish')).toBeGreaterThan(0);
    expect(lexicalScore('colombo', 'the user lives in colombo')).toBeGreaterThan(0);
  });

  it('does not fire below the length floor, so short words cannot collide', () => {
    // 'cats' is under PREFIX_MATCH_MIN_LENGTH — falls back to substring only.
    expect(lexicalScore('cats', 'category theory')).toBe(0);
  });

  it('needs a genuinely long shared prefix, not a coincidental one', () => {
    // 'catering' vs 'category' share only 'cat' + 'e' — 4 chars, under the floor of 6.
    expect(lexicalScore('catering', 'category theory')).toBe(0);
  });
});
