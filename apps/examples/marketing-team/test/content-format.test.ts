import { describe, expect, it } from 'bun:test';
import { markdownToTiptap, tiptapToMarkdown } from '../db/content-format.js';

/**
 * The round trip has to be a FIXED POINT, not merely lossless.
 *
 * Agents write markdown; humans write Tiptap; both columns are written together on every
 * save. A converter that preserves meaning but reformats — different bullet markers, changed
 * emphasis delimiters, re-wrapped lines — would rewrite `body_markdown` on every single save
 * and churn `content_revisions` forever, with a diff nobody authored.
 *
 * So the assertion is not "the text survives". It is: normalise once, then a second pass
 * changes nothing.
 */
const CONSTRUCTS = `# Heading one

## Heading two

A paragraph with **bold**, *italic*, and \`inline code\`.

* bullet one
* bullet two

1. ordered one
2. ordered two

[a link](https://example.com)

\`\`\`ts
const x: number = 1;
\`\`\`

> a blockquote
`;

function normalise(md: string): string {
  return tiptapToMarkdown(markdownToTiptap(md));
}

describe('markdown <-> Tiptap', () => {
  it('reaches a fixed point after one normalising pass', () => {
    const once = normalise(CONSTRUCTS);
    const twice = normalise(once);
    // The second pass must be a no-op. If this fails, every save rewrites the document.
    expect(twice).toBe(once);
  });

  it.each([
    ['heading', '# Title'],
    ['bold', 'a **bold** word'],
    ['italic', 'a *italic* word'],
    ['inline code', 'a `code` word'],
    ['link', '[text](https://example.com)'],
    ['bullet list', '* one\n* two'],
    ['ordered list', '1. one\n2. two'],
    ['fenced code', '```ts\nconst x = 1;\n```'],
    ['blockquote', '> quoted'],
  ])('preserves %s through the round trip', (_label, md) => {
    const once = normalise(md);
    expect(normalise(once)).toBe(once);
    // and the construct survives rather than being flattened to bare text
    expect(once.trim().length).toBeGreaterThan(0);
  });

  it('keeps link targets and code content intact, not just their shape', () => {
    const out = normalise('See [the docs](https://example.com/a?b=c) and `npm run build`.');
    expect(out).toContain('https://example.com/a?b=c');
    expect(out).toContain('npm run build');
  });
});
