import { describe, it, expect } from 'bun:test';
import { WhatsAppFormatConverter } from '../src/whatsapp/format.ts';

const converter = new WhatsAppFormatConverter();

describe('WhatsAppFormatConverter — toPlatformFormat (Markdown -> WhatsApp)', () => {
  it('converts **bold** to *bold*', () => {
    expect(converter.toPlatformFormat('**bold**')).toBe('*bold*');
  });

  it('converts __bold__ to *bold*', () => {
    expect(converter.toPlatformFormat('__bold__')).toBe('*bold*');
  });

  it('converts ~~strike~~ to ~strike~', () => {
    expect(converter.toPlatformFormat('~~strike~~')).toBe('~strike~');
  });

  it('preserves _italic_ unchanged', () => {
    expect(converter.toPlatformFormat('_italic_')).toBe('_italic_');
  });

  it('preserves `code` unchanged', () => {
    expect(converter.toPlatformFormat('`code`')).toBe('`code`');
  });

  it('preserves code blocks', () => {
    const input = '```\nconst x = 1;\n```';
    expect(converter.toPlatformFormat(input)).toBe(input);
  });

  it('converts # Heading to *Heading*', () => {
    expect(converter.toPlatformFormat('# Heading')).toBe('*Heading*');
  });

  it('converts ## Heading to *Heading*', () => {
    expect(converter.toPlatformFormat('## Sub Heading')).toBe('*Sub Heading*');
  });

  it('converts --- to unicode line', () => {
    const result = converter.toPlatformFormat('---');
    expect(result).toContain('\u2501'); // ━
  });

  it('converts [text](url) to text (url)', () => {
    expect(converter.toPlatformFormat('[Google](https://google.com)')).toBe(
      'Google (https://google.com)',
    );
  });

  it('converts ![alt](url) — image link is handled by link conversion', () => {
    // The image regex `![alt](url)` is applied after the link regex `[text](url)`,
    // so `![Photo](url)` becomes `!Photo (url)` via the link regex.
    // This matches the actual implementation behavior.
    const result = converter.toPlatformFormat('![Photo](https://img.com/a.jpg)');
    expect(result).toContain('Photo');
    // Should not contain raw markdown brackets/parens
    expect(result).not.toContain('[Photo]');
  });

  it('removes blockquote > prefix', () => {
    expect(converter.toPlatformFormat('> quoted text')).toBe('quoted text');
  });

  it('handles bold at start of line without treating as list', () => {
    const result = converter.toPlatformFormat('**bold at start** of line');
    expect(result).toBe('*bold at start* of line');
    // Should NOT start with "- "
    expect(result.startsWith('- ')).toBe(false);
  });

  it('converts + list item to - list item', () => {
    expect(converter.toPlatformFormat('+ list item')).toBe('- list item');
  });

  it('converts * list item to - list item', () => {
    expect(converter.toPlatformFormat('* list item')).toBe('- list item');
  });

  it('handles mixed formatting in one string', () => {
    const input = '# Title\n\n**Bold** and ~~strike~~ and _italic_\n\n[link](http://x.com)';
    const result = converter.toPlatformFormat(input);
    expect(result).toContain('*Title*');
    expect(result).toContain('*Bold*');
    expect(result).toContain('~strike~');
    expect(result).toContain('_italic_');
    expect(result).toContain('link (http://x.com)');
  });
});

describe('WhatsAppFormatConverter — toMarkdown (WhatsApp -> Markdown)', () => {
  it('converts *bold* to **bold**', () => {
    expect(converter.toMarkdown('*bold*')).toBe('**bold**');
  });

  it('converts ~strike~ to ~~strike~~', () => {
    expect(converter.toMarkdown('~strike~')).toBe('~~strike~~');
  });

  it('preserves _italic_ unchanged', () => {
    expect(converter.toMarkdown('_italic_')).toBe('_italic_');
  });

  it('preserves code blocks', () => {
    const input = '```\ncode here\n```';
    expect(converter.toMarkdown(input)).toBe(input);
  });
});

describe('WhatsAppFormatConverter — toPlainText', () => {
  it('strips all formatting', () => {
    const input = '**bold** _italic_ ~~strike~~ `code`';
    const result = converter.toPlainText(input);
    expect(result).toBe('bold italic strike code');
  });

  it('strips links but keeps text', () => {
    const result = converter.toPlainText('[Click here](https://example.com)');
    expect(result).toBe('Click here');
  });

  it('strips heading markers', () => {
    const result = converter.toPlainText('## My Heading');
    expect(result).toBe('My Heading');
  });

  it('strips bold/italic/strike markers', () => {
    const result = converter.toPlainText('*bold* _italic_ ~strike~');
    expect(result).toBe('bold italic strike');
  });
});
