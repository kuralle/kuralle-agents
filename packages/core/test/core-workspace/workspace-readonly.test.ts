import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/index.js';
import { createFsTool } from '../../src/tools/fs/createFsTool.js';
import {
  resolveAgentWorkspace,
  resolveAgentWorkspaceForSession,
} from '../../src/runtime/resolveAgentWorkspace.js';
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

  it('resolves a different workspace for each durable session', async () => {
    const seen: string[] = [];
    const resolved = await resolveAgentWorkspaceForSession(
      ({ session, agentId }) => {
        seen.push(`${agentId}:${session.id}`);
        return {
          fs: new InMemoryFs({ [`/sessions/${session.id}.md`]: session.id }),
          instructions: `Only use /sessions/${session.id}.md for this conversation.`,
        };
      },
      {
        agentId: 'workspace-agent',
        session: {
          id: 'tenant-42',
          conversationId: 'tenant-42',
          channelId: 'api',
          messages: [],
          currentAgent: 'workspace-agent',
          workingMemory: {},
          agentStates: {},
          handoffHistory: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );

    expect(seen).toEqual(['workspace-agent:tenant-42']);
    expect(resolved?.instructions).toContain('/sessions/tenant-42.md');
    expect(await resolved?.fs.readFile('/sessions/tenant-42.md')).toBe('tenant-42');
  });

  it('supports bounded workspace lifecycle operations', async () => {
    const fs = new InMemoryFs({ '/drafts/a.md': 'alpha' });
    const tool = createFsTool({
      fs,
      readOnly: false,
      instructions: 'Drafts live under /drafts.',
    });

    expect(tool.description).toContain('Drafts live under /drafts.');
    await tool.execute!({ op: 'mkdir', path: '/archive' });
    await tool.execute!({ op: 'mv', path: '/drafts/a.md', destination: '/archive/a.md' });
    expect(await tool.execute!({ op: 'stat', path: '/archive/a.md' })).toMatchObject({
      ok: true,
      stat: { type: 'file', size: 5 },
    });
    await tool.execute!({ op: 'rm', path: '/archive', recursive: true });
    expect(await fs.exists('/archive')).toBe(false);
    await expect(tool.execute!({ op: 'rm', path: '/', recursive: true })).rejects.toThrow(
      /refusing to remove workspace root/i,
    );
  });

  it('read-write workspace exposes a read-only model traversal surface by default', () => {
    const fs = new InMemoryFs({ '/kb/faq.md': 'FAQ' });
    const agent = defineAgent({
      id: 'kb',
      workspace: { fs, readOnly: false },
    });
    const resolved = resolveAgentWorkspace(agent.workspace);
    const executorWorkspaceTool = resolved
      ? createFsTool({ fs: resolved.fs, readOnly: resolved.readOnly })
      : undefined;
    const modelWorkspaceTool = resolved
      ? createFsTool({ fs: resolved.fs, readOnly: resolved.readOnly || !resolved.modelWritable })
      : undefined;
    const globalTools = {
      ...(modelWorkspaceTool ? { workspace: modelWorkspaceTool } : {}),
    };
    expect(globalTools.workspace).toBeDefined();
    expect(executorWorkspaceTool).toBeDefined();
    expect(resolved?.modelWritable).toBe(false);
  });

  it('modelWritable explicitly exposes workspace mutations', () => {
    const fs = new InMemoryFs();
    const resolved = resolveAgentWorkspace({ fs, readOnly: false, modelWritable: true });
    expect(resolved).toMatchObject({ readOnly: false, modelWritable: true });
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
