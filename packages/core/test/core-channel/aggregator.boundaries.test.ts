import { describe, expect, test } from 'bun:test';
import {
  SentenceAggregator,
  matchEndOfSentence,
} from '../../src/runtime/channels/streaming/SentenceAggregator.js';

function pushAll(agg: SentenceAggregator, tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) out.push(...agg.push(t));
  return out;
}

describe('matchEndOfSentence', () => {
  test('detects first sentence boundary', () => {
    expect(matchEndOfSentence('Hi there. How')).toBe(9);
    expect(matchEndOfSentence('How are you?')).toBe(12);
  });

  test('rejects decimal period', () => {
    expect(matchEndOfSentence('$29.99 is')).toBe(0);
    expect(matchEndOfSentence('$29.99 is the price.')).toBe(20);
  });

  test('rejects abbreviation periods', () => {
    expect(matchEndOfSentence('Call Dr. Smith')).toBe(0);
    expect(matchEndOfSentence('Use e.g. this')).toBe(0);
  });
});

describe('SentenceAggregator boundaries', () => {
  const cases: {
    name: string;
    tokens: string[];
    expected: string[];
    flush?: string | null;
  }[] = [
    {
      name: 'two sentences fed whole',
      tokens: ['Hi there. How are you?'],
      expected: ['Hi there.', ' How are you?'],
      flush: null,
    },
    {
      name: 'two sentences fed fragmented',
      tokens: ['Hi th', 'ere. How', ' are you?'],
      expected: ['Hi there.', ' How are you?'],
      flush: null,
    },
    {
      name: 'decimal not split',
      tokens: ['$29.99 is the price.'],
      expected: ['$29.99 is the price.'],
      flush: null,
    },
    {
      name: 'Dr abbreviation not split',
      tokens: ['Call Dr. Smith now.'],
      expected: ['Call Dr. Smith now.'],
      flush: null,
    },
    {
      name: 'e.g. abbreviation not split',
      tokens: ['Use e.g. this one.'],
      expected: ['Use e.g. this one.'],
      flush: null,
    },
    {
      name: 'ellipsis and multi-punctuation',
      tokens: ['Wait... really?!'],
      expected: ['Wait... really?!'],
      flush: null,
    },
  ];

  for (const row of cases) {
    test(row.name, () => {
      const agg = new SentenceAggregator();
      const original = row.tokens.join('');
      const sentences = pushAll(agg, row.tokens);
      expect(sentences).toEqual(row.expected);
      expect(sentences.every((s) => s.length > 0)).toBe(true);
      const tail = agg.flush();
      expect(tail).toBe(row.flush ?? null);
      expect(sentences.join('') + (tail ?? '')).toBe(original);
    });
  }

  test('flush returns trailing partial then null', () => {
    const agg = new SentenceAggregator();
    expect(agg.push('Still going')).toEqual([]);
    expect(agg.flush()).toBe('Still going');
    expect(agg.flush()).toBeNull();
  });

  test("push('') returns []", () => {
    const agg = new SentenceAggregator();
    expect(agg.push('')).toEqual([]);
  });

  test('whitespace-only push buffers without emitting', () => {
    const agg = new SentenceAggregator();
    expect(agg.push('Hi ')).toEqual([]);
    expect(agg.push('there.')).toEqual([]);
    expect(agg.push(' How')).toEqual(['Hi there.']);
    expect(agg.push(' are you?')).toEqual([' How are you?']);
  });
});
