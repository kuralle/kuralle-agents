import type { AnyExtension } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { History } from '@tiptap/extension-history';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Image } from '@tiptap/extension-image';
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
// The set below must COVER prosemirror-markdown's parser, not merely intersect it. That is the
// direction that bites: `markdownToTiptap` runs agent-written markdown through
// prosemirror-markdown's DEFAULT parser, so any node that parser can emit will reach
// `schema.nodeFromJSON` in the editor. A node this schema is missing throws "Unknown node
// type" there, React unmounts the editor, and the page renders an EMPTY document over a row
// whose `body_markdown` is perfectly intact — total, silent content loss in the UI.
//
// That is not hypothetical: a blog post whose markdown opened with a `---` thematic break
// (the model emitted YAML front matter) stored 2,973 characters and displayed nothing, because
// `horizontal_rule` was absent here. `image` and `hard_break` had the same hole. Scoping the
// editor to "the constructs we chose to support" is safe only if the WRITE path is scoped to
// the same set, and it is not — it accepts whatever the model writes.
//
// So: every node/mark prosemirror-markdown's default schema can produce has an entry here,
// under the same name and with the same attributes. Adding a construct to one side without
// the other reopens the hole, which is what `test/web/editor-roundtrip.test.ts` now pins from
// the markdown side.

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

const HorizontalRuleNode = HorizontalRule.extend({ name: 'horizontal_rule' });
const HardBreakNode = HardBreak.extend({ name: 'hard_break' });

// prosemirror-markdown declares `src` with no default, making it REQUIRED — a node built
// without it throws at construction. Tiptap's stock Image defaults every attribute to null, so
// keeping its shape here would let the editor create an image the serializer cannot write.
const ImageNode = Image.extend({
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    };
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
  HorizontalRuleNode,
  HardBreakNode,
  ImageNode,
  StrongMark,
  EmMark,
  Code,
  LinkMark,
  History,
];
