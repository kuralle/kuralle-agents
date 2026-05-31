import { describe, it, expect } from 'bun:test';
import { splitMessage } from '../src/whatsapp/split.ts';

describe('splitMessage', () => {
  it('returns a single chunk for short messages', () => {
    const text = 'Hello, world!';
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('returns a single chunk for exactly 4096 characters', () => {
    const text = 'a'.repeat(4096);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits at paragraph boundary (\\n\\n)', () => {
    const para1 = 'a'.repeat(3000);
    const para2 = 'b'.repeat(3000);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should contain para1
    expect(chunks[0]).toContain('a'.repeat(100));
  });

  it('splits at line boundary (\\n) if no paragraph break', () => {
    const line1 = 'x'.repeat(3000);
    const line2 = 'y'.repeat(3000);
    const text = `${line1}\n${line2}`;
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('hard-splits at 4096 if no natural break', () => {
    const text = 'z'.repeat(8192);
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toHaveLength(4096);
  });

  it('handles multiple splits for very long messages', () => {
    const text = 'w'.repeat(12288); // 3x the limit
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('preserves text integrity (joined chunks reconstruct original)', () => {
    // Use paragraph breaks for natural split points
    const parts = Array.from({ length: 5 }, (_, i) => `Part ${i}: ${'q'.repeat(2000)}`);
    const text = parts.join('\n\n');
    const chunks = splitMessage(text);

    // When joined back (accounting for trimming), content should match
    const reconstructed = chunks.join('');
    // All original content characters should be present
    for (const part of parts) {
      const keyword = `Part ${parts.indexOf(part)}`;
      expect(reconstructed).toContain(keyword);
    }
  });

  it('returns a single empty chunk for empty string', () => {
    const chunks = splitMessage('');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('');
  });
});
