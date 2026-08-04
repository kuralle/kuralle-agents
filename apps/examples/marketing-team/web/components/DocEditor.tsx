'use client';

import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import { editorExtensions } from '@/lib/tiptap-schema';

export function DocEditor({
  content,
  onChange,
  editable = true,
}: {
  content: JSONContent;
  onChange?: (json: JSONContent) => void;
  editable?: boolean;
}) {
  const editor = useEditor({
    extensions: editorExtensions,
    content,
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor: instance }) => onChange?.(instance.getJSON()),
  });

  if (!editor) return null;

  return (
    <div>
      <Toolbar editor={editor} />
      <div className="editor-shell">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    // eslint-disable-next-line no-alert -- a demo editor toolbar; a proper app would use a form
    const url = window.prompt('Link URL', previous ?? 'https://');
    if (url === null) return;
    if (!url.trim()) {
      editor.chain().focus().unsetMark('link').run();
      return;
    }
    editor.chain().focus().setMark('link', { href: url.trim() }).run();
  };

  return (
    <div className="toolbar">
      <ToolbarButton
        label="B"
        active={editor.isActive('strong')}
        onClick={() => editor.chain().focus().toggleMark('strong').run()}
      />
      <ToolbarButton
        label="I"
        active={editor.isActive('em')}
        onClick={() => editor.chain().focus().toggleMark('em').run()}
      />
      <ToolbarButton
        label="Code"
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleMark('code').run()}
      />
      <ToolbarButton label="Link" active={editor.isActive('link')} onClick={setLink} />
      <ToolbarButton
        label="H1"
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleNode('heading', 'paragraph', { level: 1 }).run()}
      />
      <ToolbarButton
        label="H2"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleNode('heading', 'paragraph', { level: 2 }).run()}
      />
      <ToolbarButton
        label="• List"
        active={editor.isActive('bullet_list')}
        onClick={() => editor.chain().focus().toggleList('bullet_list', 'list_item').run()}
      />
      <ToolbarButton
        label="1. List"
        active={editor.isActive('ordered_list')}
        onClick={() => editor.chain().focus().toggleList('ordered_list', 'list_item').run()}
      />
      <ToolbarButton
        label="Quote"
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleWrap('blockquote').run()}
      />
      <ToolbarButton
        label="Code block"
        active={editor.isActive('code_block')}
        onClick={() => editor.chain().focus().toggleNode('code_block', 'paragraph').run()}
      />
    </div>
  );
}

function ToolbarButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" data-active={active} onClick={onClick}>
      {label}
    </button>
  );
}
