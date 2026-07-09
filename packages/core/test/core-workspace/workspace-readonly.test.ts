import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/index.js';
import { createFsTool } from '../../src/tools/fs/createFsTool.js';
import { resolveAgentWorkspace } from '../../src/runtime/resolveAgentWorkspace.js';
import { InMemoryFs } from '@kuralle-agents/fs';

describe('workspace readOnly default', () => {
  it('defaults readOnly to true for a bare FileSystem', () => {
    const fs = new InMemoryFs({ '/kb/faq.md': 'FAQ' });
    const resolved = resolveAgentWorkspace(fs);
    expect(resolved?.readOnly).toBe(true);
  });

  it('honours readOnly: false on the object form', () => {
    const fs = new InMemoryFs({ '/scratch/note.md': 'draft' });
    const resolved = resolveAgentWorkspace({ fs, readOnly: false });
    expect(resolved?.readOnly).toBe(false);
  });

  it('read-only workspace rejects write', async () => {
    const fs = new InMemoryFs({});
    const tool = createFsTool({ fs });
    await expect(tool.execute!({ op: 'write', path: '/x.md', content: 'nope' })).rejects.toThrow(
      /EROFS|read-only/i,
    );
  });

  it('read-write workspace allows write when readOnly is false', async () => {
    const fs = new InMemoryFs({});
    const tool = createFsTool({ fs, readOnly: false });
    const result = await tool.execute!({ op: 'write', path: '/x.md', content: 'ok' });
    expect(result).toMatchObject({ op: 'write', ok: true });
  });

  it('read-write workspace is not auto-exposed in globalTools shape', () => {
    const fs = new InMemoryFs({ '/kb/faq.md': 'FAQ' });
    const agent = defineAgent({
      id: 'kb',
      workspace: { fs, readOnly: false },
    });
    const resolved = resolveAgentWorkspace(agent.workspace);
    const workspaceTool = resolved
      ? createFsTool({ fs: resolved.fs, readOnly: resolved.readOnly })
      : undefined;
    const globalTools = {
      ...(workspaceTool && resolved?.readOnly !== false ? { workspace: workspaceTool } : {}),
    };
    expect(globalTools.workspace).toBeUndefined();
    expect(workspaceTool).toBeDefined();
  });

  it('read-only workspace is auto-exposed in globalTools shape', () => {
    const fs = new InMemoryFs({ '/kb/faq.md': 'FAQ' });
    const agent = defineAgent({ id: 'kb', workspace: fs });
    const resolved = resolveAgentWorkspace(agent.workspace);
    const workspaceTool = resolved
      ? createFsTool({ fs: resolved.fs, readOnly: resolved.readOnly })
      : undefined;
    const globalTools = {
      ...(workspaceTool && resolved?.readOnly !== false ? { workspace: workspaceTool } : {}),
    };
    expect(globalTools.workspace).toBeDefined();
    expect(globalTools.workspace?.name).toBe('workspace');
  });
});
