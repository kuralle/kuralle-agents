import { defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown';

// Content is stored twice — body_json (Tiptap/ProseMirror document) and
// body_markdown (what agents read and write) — and both must always be
// written together in the same transaction. Tiptap's document JSON is the
// same shape as ProseMirror's, so no adapter layer sits between them: this
// module is a thin, established-library wrapper (prosemirror-markdown) over
// the parse/serialize pair, chosen over hand-rolling a markdown parser.

export type TiptapDocument = Record<string, unknown>;

export function markdownToTiptap(markdown: string): TiptapDocument {
  const doc = defaultMarkdownParser.parse(markdown);
  if (!doc) {
    throw new Error('markdownToTiptap: parser produced no document');
  }
  return doc.toJSON() as TiptapDocument;
}

export function tiptapToMarkdown(doc: TiptapDocument): string {
  const node = defaultMarkdownParser.schema.nodeFromJSON(doc);
  return defaultMarkdownSerializer.serialize(node);
}
