import type { AnyExtension } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { Heading } from '@tiptap/extension-heading';
import { History } from '@tiptap/extension-history';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';

// `db/content-format.ts` reconstructs a ProseMirror node with
// `defaultMarkdownParser.schema.nodeFromJSON(doc)` — that call resolves every node/mark in
// `body_json` by TYPE NAME against prosemirror-markdown's own schema
// (node_modules/prosemirror-markdown: doc, paragraph, blockquote, horizontal_rule, heading,
// code_block, ordered_list, bullet_list, list_item, text, image, hard_break; marks: em,
// strong, link, code). Tiptap's stock extensions use different names and attrs for several
// of these (bulletList/orderedList/listItem/codeBlock, bold/italic), so this module renames
// and re-shapes them to match exactly. An extension left at its Tiptap default name would
// round-trip through THIS file's schema but throw "Unknown node type" — or silently drop
// attributes — the moment `tiptapToMarkdown` hands the JSON to prosemirror-markdown's schema.
//
// Only the constructs the content editor is scoped to support are included (headings, bullet
// and ordered lists, links, inline code, fenced code blocks, bold, italic, blockquote) plus
// the unavoidable baseline (doc, paragraph, text). Every included node/mark name below has a
// matching entry in prosemirror-markdown's default parser/serializer, so nothing here can
// silently corrupt `body_markdown` on save.

const ListItemNode = ListItem.extend({ name: 'list_item' });

const BulletListNode = BulletList.extend({
  name: 'bullet_list',
  addAttributes() {
    return { tight: { default: false } };
  },
}).configure({ itemTypeName: 'list_item' });

const OrderedListNode = OrderedList.extend({
  name: 'ordered_list',
  addAttributes() {
    return {
      order: { default: 1 },
      tight: { default: false },
    };
  },
}).configure({ itemTypeName: 'list_item' });

const CodeBlockNode = CodeBlock.extend({
  name: 'code_block',
  addAttributes() {
    return { params: { default: '' } };
  },
});

const StrongMark = Bold.extend({ name: 'strong' });
const EmMark = Italic.extend({ name: 'em' });

const LinkMark = Link.extend({
  addAttributes() {
    return {
      href: { default: null },
      title: { default: null },
    };
  },
}).configure({ openOnClick: false, autolink: false });

/**
 * The single source of truth for the editor's document model — passed to `useEditor` for the
 * mounted editor AND to `getSchema` in the round-trip test, so the test proves the schema the
 * editor actually produces, not a hand-written stand-in for it.
 */
export const editorExtensions: AnyExtension[] = [
  Document,
  Paragraph,
  Text,
  Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
  Blockquote,
  BulletListNode,
  OrderedListNode,
  ListItemNode,
  ListKeymap,
  CodeBlockNode,
  StrongMark,
  EmMark,
  Code,
  LinkMark,
  History,
];
