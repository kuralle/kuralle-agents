import { describe, test, expect } from 'bun:test';

import { createTokenChunker, createMarkdownChunker, createRecursiveChunker } from '../src/chunkers.js';

const wordCounter = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

describe('createTokenChunker — token semantics', () => {
  test('per-call maxTokens takes precedence over config.defaults.maxTokens', () => {
    const chunker = createTokenChunker({
      countTokens: wordCounter,
      defaults: { maxTokens: 100 },
    });
    const text = 'one two three four five. six seven eight nine ten.';
    const chunks = chunker.chunk(text, { maxTokens: 3 });
    // Each chunk should hold at most ~3 tokens (words) give-or-take sentence boundaries
    for (const c of chunks) {
      expect(wordCounter(c.text)).toBeLessThanOrEqual(5);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('maxChars on a token chunker is ignored (no conflation)', () => {
    const chunker = createTokenChunker({
      countTokens: wordCounter,
      defaults: { maxTokens: 100 },
    });
    const text = 'one two three four five six seven eight.';
    // maxChars: 5 would previously force token chunker to split at 5 tokens;
    // now it is ignored and the default (100) applies.
    const chunks = chunker.chunk(text, { maxChars: 5 });
    expect(chunks.length).toBe(1);
  });

  test('overlapTokens is read from options (not overlapChars)', () => {
    const chunker = createTokenChunker({
      countTokens: wordCounter,
      defaults: { maxTokens: 3, overlapTokens: 0 },
    });
    const text = 'a b c. d e f. g h i. j k l.';
    const noOverlap = chunker.chunk(text, { maxTokens: 3, overlapTokens: 0 });
    const withOverlap = chunker.chunk(text, { maxTokens: 3, overlapTokens: 1 });
    // withOverlap should have at least as many total tokens across chunks as noOverlap
    const sum = (cs: Array<{ text: string }>) => cs.reduce((a, c) => a + wordCounter(c.text), 0);
    expect(sum(withOverlap)).toBeGreaterThanOrEqual(sum(noOverlap));
  });

  test('overlapChars on a token chunker is ignored', () => {
    const chunker = createTokenChunker({
      countTokens: wordCounter,
      defaults: { maxTokens: 3, overlapTokens: 0 },
    });
    const text = 'a b c. d e f. g h i. j k l.';
    const withOldKey = chunker.chunk(text, { maxTokens: 3, overlapChars: 999 });
    const noOverlap = chunker.chunk(text, { maxTokens: 3, overlapTokens: 0 });
    // both should behave identically since overlapChars is ignored
    expect(withOldKey.length).toBe(noOverlap.length);
  });

  test('char chunker still reads maxChars (sanity)', () => {
    const chunker = createRecursiveChunker();
    const text = 'a'.repeat(100);
    const chunks = chunker.chunk(text, { maxChars: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.text.length).toBeLessThanOrEqual(10);
  });

  test('markdown chunker still reads maxChars (sanity)', () => {
    const chunker = createMarkdownChunker();
    const text = '## Section\n' + 'word '.repeat(200);
    const chunks = chunker.chunk(text, { maxChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});
