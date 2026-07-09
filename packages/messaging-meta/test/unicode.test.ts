import { describe, it, expect } from 'bun:test';
import { graphemeCount, sliceGraphemes, graphemes } from '../src/unicode.ts';
import { WhatsAppFormatConverter } from '../src/whatsapp/format.ts';

describe('graphemeCount', () => {
  it('counts ASCII characters', () => {
    expect(graphemeCount('hello')).toBe(5);
  });

  it('counts a single emoji as one grapheme', () => {
    expect(graphemeCount('\u{1f600}')).toBe(1);
  });

  it('counts ZWJ family emoji as one grapheme', () => {
    // 👨‍👩‍👧‍👦 (man + ZWJ + woman + ZWJ + girl + ZWJ + boy) = 1 grapheme
    expect(graphemeCount('\u{1f468}‍\u{1f469}‍\u{1f467}‍\u{1f466}')).toBe(1);
  });

  it('counts combining marks as one grapheme with the base character', () => {
    // á (a + combining acute) = 1 grapheme
    expect(graphemeCount('á')).toBe(1);
  });

  it('handles Arabic RTL text', () => {
    // السلام — each glyph is its own grapheme
    expect(graphemeCount('السلام')).toBe(6);
  });
});

describe('sliceGraphemes', () => {
  it('slices ASCII by grapheme', () => {
    expect(sliceGraphemes('abcde', 3)).toBe('abc');
  });

  it('does not tear emoji', () => {
    const s = 'A\u{1f600}B';
    // After the emoji there's a B; slicing 2 graphemes = 'A' + emoji
    expect(sliceGraphemes(s, 2)).toBe('A\u{1f600}');
  });

  it('returns empty for non-positive n', () => {
    expect(sliceGraphemes('abc', 0)).toBe('');
    expect(sliceGraphemes('abc', -1)).toBe('');
  });
});

describe('graphemes', () => {
  it('returns an array of graphemes', () => {
    expect(graphemes('a\u{1f600}b')).toEqual(['a', '\u{1f600}', 'b']);
  });
});

// ===========================================================================
// WhatsAppFormatConverter — Unicode edge cases (C-13.8)
// ===========================================================================

describe('WhatsAppFormatConverter — Unicode safety', () => {
  const converter = new WhatsAppFormatConverter();

  it('toPlatformFormat preserves ZWJ emoji sequences inside bold', () => {
    const input = '**Hello \u{1f468}‍\u{1f469}‍\u{1f467}**';
    const out = converter.toPlatformFormat(input);
    expect(out).toBe('*Hello \u{1f468}‍\u{1f469}‍\u{1f467}*');
    // ZWJ (U+200D) must still be present between the people emojis.
    expect(out.includes('‍')).toBe(true);
  });

  it('toPlatformFormat preserves skin-tone modified emoji', () => {
    // 👍🏽 (thumbs up + medium skin tone modifier)
    const input = '**Nice work \u{1f44d}\u{1f3fd}**';
    const out = converter.toPlatformFormat(input);
    expect(out).toBe('*Nice work \u{1f44d}\u{1f3fd}*');
  });

  it('toPlatformFormat preserves combining diacritic inside bold', () => {
    const input = '**café à la carte**';
    const out = converter.toPlatformFormat(input);
    expect(out).toBe('*café à la carte*');
  });

  it('toPlatformFormat preserves RTL Arabic inside bold', () => {
    const input = '**السلام عليكم**';
    const out = converter.toPlatformFormat(input);
    expect(out).toBe('*السلام عليكم*');
  });

  it('toPlatformFormat preserves emoji in strikethrough', () => {
    const input = '~~Fail \u{1f4a5}~~';
    const out = converter.toPlatformFormat(input);
    expect(out).toBe('~Fail \u{1f4a5}~');
  });

  it('toMarkdown preserves emoji when promoting * → **', () => {
    const input = '*Hello \u{1f600}*';
    const out = converter.toMarkdown(input);
    expect(out).toBe('**Hello \u{1f600}**');
  });

  it('toPlainText strips formatting around Arabic text without tearing it', () => {
    const input = '**السلام**';
    const out = converter.toPlainText(input);
    expect(out).toBe('السلام');
  });
});
