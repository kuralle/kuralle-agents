import { describe, it, expect } from 'bun:test';
import { MessengerFormatConverter } from '../src/messenger/format.ts';

const converter = new MessengerFormatConverter();

describe('MessengerFormatConverter — toPlatformFormat (Markdown -> plain text)', () => {
  it('strips **bold** to plain text', () => {
    expect(converter.toPlatformFormat('**bold**')).toBe('bold');
  });

  it('strips __bold__ to plain text', () => {
    expect(converter.toPlatformFormat('__bold__')).toBe('bold');
  });

  it('strips ~~strike~~ to plain text', () => {
    expect(converter.toPlatformFormat('~~strike~~')).toBe('strike');
  });

  it('strips # headings to plain text', () => {
    expect(converter.toPlatformFormat('# My Heading')).toBe('My Heading');
  });

  it('strips ## headings to plain text', () => {
    expect(converter.toPlatformFormat('## Sub Heading')).toBe('Sub Heading');
  });

  it('strips ### headings to plain text', () => {
    expect(converter.toPlatformFormat('### Third Level')).toBe('Third Level');
  });

  it('strips [links](url) keeping text and URL', () => {
    expect(converter.toPlatformFormat('[Google](https://google.com)')).toBe(
      'Google (https://google.com)',
    );
  });

  it('handles plain text passthrough', () => {
    expect(converter.toPlatformFormat('plain text message')).toBe('plain text message');
  });

  it('strips _italic_ to plain text', () => {
    expect(converter.toPlatformFormat('_italic_')).toBe('italic');
  });

  it('strips inline `code` markers', () => {
    expect(converter.toPlatformFormat('use `const` here')).toBe('use const here');
  });

  it('strips code blocks but keeps content', () => {
    const input = '```\nconst x = 1;\n```';
    const result = converter.toPlatformFormat(input);
    expect(result).toContain('const x = 1;');
    expect(result).not.toContain('```');
  });

  it('strips image markdown keeping alt text', () => {
    expect(converter.toPlatformFormat('![Photo](https://img.com/a.jpg)')).toBe('Photo');
  });

  it('strips blockquote > prefix', () => {
    expect(converter.toPlatformFormat('> quoted text')).toBe('quoted text');
  });

  it('strips horizontal rules', () => {
    const result = converter.toPlatformFormat('---');
    expect(result.trim()).toBe('');
  });

  it('handles mixed formatting in one string', () => {
    const input = '# Title\n\n**Bold** and ~~strike~~ and _italic_\n\n[link](http://x.com)';
    const result = converter.toPlatformFormat(input);
    expect(result).toContain('Title');
    expect(result).toContain('Bold');
    expect(result).toContain('strike');
    expect(result).toContain('italic');
    expect(result).toContain('link');
    // Should not contain markdown markers
    expect(result).not.toContain('**');
    expect(result).not.toContain('~~');
    expect(result).not.toContain('](');
  });
});

describe('MessengerFormatConverter — toMarkdown', () => {
  it('returns text unchanged (identity operation)', () => {
    expect(converter.toMarkdown('plain text')).toBe('plain text');
  });

  it('preserves text with special characters unchanged', () => {
    expect(converter.toMarkdown('Hello & goodbye <world>')).toBe('Hello & goodbye <world>');
  });

  it('preserves multiline text unchanged', () => {
    const input = 'Line 1\nLine 2\nLine 3';
    expect(converter.toMarkdown(input)).toBe(input);
  });
});

describe('MessengerFormatConverter — toPlainText', () => {
  it('strips all formatting', () => {
    const input = '**bold** _italic_ ~~strike~~ `code`';
    const result = converter.toPlainText(input);
    expect(result).toBe('bold italic strike code');
  });

  it('strips links but keeps text and URL', () => {
    const result = converter.toPlainText('[Click here](https://example.com)');
    expect(result).toBe('Click here (https://example.com)');
  });

  it('strips heading markers', () => {
    const result = converter.toPlainText('## My Heading');
    expect(result).toBe('My Heading');
  });

  it('strips bold markers', () => {
    const result = converter.toPlainText('**bold text**');
    expect(result).toBe('bold text');
  });

  it('handles empty string', () => {
    expect(converter.toPlainText('')).toBe('');
  });
});
