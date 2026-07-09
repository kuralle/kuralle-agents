import { describe, it, expect } from 'bun:test';
import {
  SmartSplitter,
  TruncateSplitter,
  ByteLimitSplitter,
} from '../src/message-splitter.ts';

describe('SmartSplitter', () => {
  it('returns single chunk when under limit', () => {
    expect(new SmartSplitter(100).split('short text')).toEqual(['short text']);
  });

  it('splits at paragraph boundary when one falls in the back half', () => {
    const text = 'x'.repeat(3000) + '\n\n' + 'y'.repeat(3000);
    const chunks = new SmartSplitter(4096).split(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('x'.repeat(3000));
    expect(chunks[1]).toBe('y'.repeat(3000));
  });

  it('falls back to line boundary when no paragraph available', () => {
    const text = 'x'.repeat(3000) + '\n' + 'y'.repeat(3000);
    const chunks = new SmartSplitter(4096).split(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('x'.repeat(3000));
    expect(chunks[1]).toBe('y'.repeat(3000));
  });

  it('falls back to word boundary when no line breaks', () => {
    const text = 'a'.repeat(3000) + ' ' + 'b'.repeat(3000);
    const chunks = new SmartSplitter(4096).split(text);
    expect(chunks).toHaveLength(2);
  });

  it('hard-splits when no boundary in back half', () => {
    const text = 'x'.repeat(10000);
    const chunks = new SmartSplitter(4096).split(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join('')).toBe(text);
  });
});

describe('TruncateSplitter', () => {
  it('returns single chunk when under limit', () => {
    expect(new TruncateSplitter(100).split('hi')).toEqual(['hi']);
  });

  it('truncates to maxChars when over limit', () => {
    const out = new TruncateSplitter(10).split('abcdefghijklmno');
    expect(out).toEqual(['abcdefghij']);
  });
});

describe('ByteLimitSplitter', () => {
  it('returns single chunk for ASCII under limit', () => {
    expect(new ByteLimitSplitter(20).split('short')).toEqual(['short']);
  });

  it('keeps chunks under the byte limit for multi-byte content', () => {
    // Each grinning-face emoji is 4 UTF-8 bytes.
    const emoji = '\u{1f600}';
    const text = emoji.repeat(400); // 1600 bytes
    const chunks = new ByteLimitSplitter(1000).split(text);
    const enc = new TextEncoder();
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(enc.encode(c).byteLength).toBeLessThanOrEqual(1000);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('never splits in the middle of a code point (Instagram edge case)', () => {
    const text = '世界'.repeat(400); // CJK, 3 bytes/char
    const chunks = new ByteLimitSplitter(1000).split(text);
    for (const c of chunks) {
      // Round-tripping through Buffer would catch torn surrogate pairs.
      expect(Buffer.from(c, 'utf8').toString('utf8')).toBe(c);
    }
    expect(chunks.join('')).toBe(text);
  });
});
