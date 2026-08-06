import { describe, expect, it } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { markdownToTiptap, tiptapToMarkdown } from '../../db/content-format.js';
import { editorExtensions } from '../../web/lib/tiptap-schema.js';

/**
 * `web/lib/tiptap-schema.ts` is the extension array `useEditor` mounts in the browser. This
 * test builds documents through `getSchema(editorExtensions)` — the exact schema object Tiptap
 * derives from that array — not hand-written JSON, so a construct the editor cannot actually
 * produce (a mismatched node name, a missing attribute) fails here the same way it would fail
 * in the browser. See the sabotage note at the bottom of this file for how this was verified.
 */
const schema = getSchema(editorExtensions);

function markdownFromEditorDoc(build: (s: typeof schema) => import('@tiptap/core').JSONContent): string {
  const doc = schema.nodeFromJSON(build(schema));
  return tiptapToMarkdown(doc.toJSON());
}

describe('editor schema <-> markdown', () => {
  it('reaches a fixed point for a document built from every required construct', () => {
    const doc = schema.node('doc', null, [
      schema.node('heading', { level: 1 }, [schema.text('Heading one')]),
      schema.node('heading', { level: 2 }, [schema.text('Heading two')]),
      schema.node('paragraph', null, [
        schema.text('A paragraph with '),
        schema.text('bold', [schema.mark('strong')]),
        schema.text(', '),
        schema.text('italic', [schema.mark('em')]),
        schema.text(', and '),
        schema.text('inline code', [schema.mark('code')]),
        schema.text('.'),
      ]),
      schema.node('bullet_list', { tight: true }, [
        schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('bullet one')])]),
        schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('bullet two')])]),
      ]),
      schema.node('ordered_list', { order: 1, tight: true }, [
        schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('ordered one')])]),
        schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('ordered two')])]),
      ]),
      schema.node('paragraph', null, [
        schema.text('a link', [schema.mark('link', { href: 'https://example.com', title: null })]),
      ]),
      schema.node('code_block', { params: 'ts' }, [schema.text('const x: number = 1;')]),
      schema.node('blockquote', null, [schema.node('paragraph', null, [schema.text('a blockquote')])]),
    ]);

    const once = tiptapToMarkdown(doc.toJSON());
    const twice = tiptapToMarkdown(markdownToTiptap(once));
    // The second pass must be a no-op, exactly like `test/content-format.test.ts` — otherwise
    // opening and re-saving a piece with no edits would rewrite `body_markdown` every time.
    expect(twice).toBe(once);
    expect(once).toContain('# Heading one');
    expect(once).toContain('## Heading two');
    expect(once).toContain('**bold**');
    expect(once).toContain('*italic*');
    expect(once).toContain('`inline code`');
    expect(once).toContain('* bullet one');
    expect(once).toContain('1. ordered one');
    expect(once).toContain('[a link](https://example.com)');
    expect(once).toContain('```ts');
    expect(once).toContain('> a blockquote');
  });

  it.each([
    ['heading', (s: typeof schema) => s.node('doc', null, [s.node('heading', { level: 1 }, [s.text('Title')])])],
    [
      'bold',
      (s: typeof schema) =>
        s.node('doc', null, [s.node('paragraph', null, [s.text('a bold word', [s.mark('strong')])])]),
    ],
    [
      'italic',
      (s: typeof schema) => s.node('doc', null, [s.node('paragraph', null, [s.text('a italic word', [s.mark('em')])])]),
    ],
    [
      'inline code',
      (s: typeof schema) =>
        s.node('doc', null, [s.node('paragraph', null, [s.text('a code word', [s.mark('code')])])]),
    ],
    [
      'link',
      (s: typeof schema) =>
        s.node('doc', null, [
          s.node('paragraph', null, [s.text('text', [s.mark('link', { href: 'https://example.com', title: null })])]),
        ]),
    ],
    [
      'bullet list',
      (s: typeof schema) =>
        s.node('doc', null, [
          s.node('bullet_list', { tight: true }, [
            s.node('list_item', null, [s.node('paragraph', null, [s.text('one')])]),
            s.node('list_item', null, [s.node('paragraph', null, [s.text('two')])]),
          ]),
        ]),
    ],
    [
      'ordered list',
      (s: typeof schema) =>
        s.node('doc', null, [
          s.node('ordered_list', { order: 1, tight: true }, [
            s.node('list_item', null, [s.node('paragraph', null, [s.text('one')])]),
            s.node('list_item', null, [s.node('paragraph', null, [s.text('two')])]),
          ]),
        ]),
    ],
    [
      'fenced code',
      (s: typeof schema) => s.node('doc', null, [s.node('code_block', { params: 'ts' }, [s.text('const x = 1;')])]),
    ],
    [
      'blockquote',
      (s: typeof schema) =>
        s.node('doc', null, [s.node('blockquote', null, [s.node('paragraph', null, [s.text('quoted')])])]),
    ],
  ] as const)('preserves %s through the round trip', (_label, build) => {
    const once = tiptapToMarkdown(build(schema).toJSON());
    const twice = tiptapToMarkdown(markdownToTiptap(once));
    expect(twice).toBe(once);
    expect(once.trim().length).toBeGreaterThan(0);
  });
});

/**
 * SABOTAGE (workmanship rule 6), performed and observed, not asserted:
 *
 *   Commented out the `CodeBlockNode,` line in the `editorExtensions` array in
 *   `web/lib/tiptap-schema.ts`. Confirmed with `grep -n CodeBlockNode web/lib/tiptap-schema.ts`
 *   that only that array entry changed (the `const CodeBlockNode = ...` definition above it was
 *   untouched, so a missing edit couldn't hide as "already gone").
 *
 *   Result: `bun test test/web/editor-roundtrip.test.ts` went from 10 pass / 0 fail to 8 pass /
 *   2 fail — both fenced-code-block cases:
 *     - "reaches a fixed point for a document built from every required construct", failing at
 *       this file's `schema.node('code_block', ...)` call (line 45 at the time), and
 *     - "preserves fenced code through the round trip" (the `it.each` row), failing at its
 *       `build(schema)` call (lines 111 → 119).
 *   Both threw `RangeError: Unknown node type: code_block` from prosemirror-model's
 *   `Schema.nodeType` — the error names the missing schema entry, not a collateral failure
 *   elsewhere, which is what this sabotage is supposed to prove: `getSchema(editorExtensions)`
 *   genuinely stops accepting `code_block` once the extension is gone.
 *
 *   Restored the `CodeBlockNode,` line, re-ran the suite: 10 pass / 0 fail again.
 */

/**
 * The enumerated round-trip above proves the constructs it lists survive. It cannot notice a
 * NEW extension someone mounts later, because it never builds a document containing one —
 * verified by sabotage: adding an unserializable node to `editorExtensions` left it green.
 *
 * This closes that gap by comparing the editor's schema against the serializer's coverage
 * directly, so the guard is derived from both sides rather than from a list someone maintains.
 * An extension the markdown serializer has no rule for would silently drop content from
 * `body_markdown` on every save — the column agents read.
 */
describe('every editor node and mark is serializable', () => {
  it('the markdown serializer has a rule for every node in the editor schema', async () => {
    const { defaultMarkdownSerializer } = await import('prosemirror-markdown');
    const known = new Set(Object.keys(defaultMarkdownSerializer.nodes));
    // `doc` and `text` are handled intrinsically by the serializer — it walks the doc's
    // children and emits text directly — so neither appears in the nodes map by design.
    known.add('doc');
    known.add('text');
    const missing = Object.keys(schema.nodes).filter((name) => !known.has(name));
    expect(missing).toEqual([]);
  });

  it('the markdown serializer has a rule for every mark in the editor schema', async () => {
    const { defaultMarkdownSerializer } = await import('prosemirror-markdown');
    const known = new Set(Object.keys(defaultMarkdownSerializer.marks));
    const missing = Object.keys(schema.marks).filter((name) => !known.has(name));
    expect(missing).toEqual([]);
  });
});

/**
 * The symmetric guard, and the one that was missing.
 *
 * The suite above proves every node the EDITOR can build is serializable. It cannot prove the
 * converse, because it builds its documents from the editor's own schema — a node the editor
 * lacks is simply never constructed, so the test passes while the app is broken.
 *
 * The failing direction is the one real content takes: an agent writes markdown,
 * `markdownToTiptap` runs it through prosemirror-markdown's DEFAULT parser, and the editor
 * calls `schema.nodeFromJSON` on the result. A node the parser emits but the editor lacks
 * throws "Unknown node type" there and the page renders an EMPTY editor over a fully intact
 * `body_markdown` — silent, total content loss in the UI.
 *
 * A real blog post hit exactly this: its markdown opened with a `---` thematic break, and
 * 2,973 stored characters displayed as a blank editor because `horizontal_rule` was not in the
 * editor schema. `image` and `hard_break` had the same hole.
 */
describe('every node the markdown parser can emit is renderable by the editor', () => {
  it('the editor schema covers prosemirror-markdown’s parser schema', async () => {
    const { defaultMarkdownParser } = await import('prosemirror-markdown');
    const editorNodes = new Set(Object.keys(schema.nodes));
    const missing = Object.keys(defaultMarkdownParser.schema.nodes).filter((n) => !editorNodes.has(n));
    expect(missing).toEqual([]);
  });

  it('the editor schema covers prosemirror-markdown’s parser marks', async () => {
    const { defaultMarkdownParser } = await import('prosemirror-markdown');
    const editorMarks = new Set(Object.keys(schema.marks));
    const missing = Object.keys(defaultMarkdownParser.schema.marks).filter((m) => !editorMarks.has(m));
    expect(missing).toEqual([]);
  });

  // The coverage checks above compare name sets. These load real agent-written markdown the
  // way the page does, so an attribute mismatch (not just a missing name) fails too.
  const AGENT_MARKDOWN: Record<string, string> = {
    'a thematic break': 'Intro paragraph.\n\n---\n\nAfter the rule.\n',
    'front matter the model emitted as a fence': '---\nmeta_description: x\n---\n\nBody text.\n',
    'an image': '![alt text](https://example.com/a.png)\n',
    'a hard break': 'line one  \nline two\n',
  };

  for (const [name, markdown] of Object.entries(AGENT_MARKDOWN)) {
    it(`loads ${name} into the editor schema without throwing`, () => {
      expect(() => schema.nodeFromJSON(markdownToTiptap(markdown))).not.toThrow();
    });
  }

  it('still reaches a fixed point for markdown carrying those constructs', () => {
    const markdown = 'Intro.\n\n---\n\n![alt](https://example.com/a.png)\n';
    const once = tiptapToMarkdown(markdownToTiptap(markdown));
    const twice = tiptapToMarkdown(markdownToTiptap(once));
    expect(twice).toBe(once);
  });
});
