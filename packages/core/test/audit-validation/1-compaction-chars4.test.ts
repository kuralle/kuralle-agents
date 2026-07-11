// FINDING 1: chars/4 remains the fallback estimate when real usage is absent | anchor src/runtime/ContextBudget.ts:65
import { describe, expect, it } from 'bun:test';
import { estimateTokenCount } from '../../src/runtime/ContextBudget.js';

describe('F1: chars/4 fallback estimate', () => {
  it('estimateTokenCount uses Math.ceil(length / 4)', () => {
    const samples = ['', 'a', 'abcd', 'abcde', 'hello world', 'x'.repeat(100)];
    for (const text of samples) {
      const expected = text.length === 0 ? 0 : Math.ceil(text.length / 4);
      expect(estimateTokenCount(text)).toBe(expected);
    }
  });
});