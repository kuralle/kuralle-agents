import { describe, expect, it } from 'bun:test';
import type { LanguageModel } from 'ai';
import { wireAgentSkills } from '@kuralle-agents/core';
import { InMemoryFs } from '@kuralle-agents/fs';
import { buildPharmacyAgent } from '../src/agent.js';
import { createPharmacyWorkspace } from '../src/workspace.js';

const model = {} as LanguageModel;

describe('Kuralle-native pharmacy agent', () => {
  it('keeps skills outside the traversable workspace and resolves them progressively', async () => {
    const notes = new InMemoryFs();
    const agent = buildPharmacyAgent({ model, notesFileSystem: notes });
    if (typeof agent.workspace !== 'function') throw new Error('Expected a per-session workspace resolver.');
    const workspace = await agent.workspace({
      agentId: agent.id,
      session: {
        id: 'test-session', conversationId: 'test-session', channelId: 'test',
        messages: [], currentAgent: agent.id, workingMemory: {},
        agentStates: {}, handoffHistory: [], createdAt: new Date(), updatedAt: new Date(),
      },
    });
    const fs = 'fs' in workspace ? workspace.fs : workspace;
    const wired = await wireAgentSkills(agent, fs);

    expect(await fs.readdir('/')).toEqual(['knowledge', 'notes']);
    expect(await fs.exists('/skills')).toBe(false);
    expect(wired?.promptSections[0]?.content).toContain('prescription-intake');
    expect(wired?.promptSections[0]?.content).not.toContain('Clarification checklist');
    expect(await wired?.tools.load_skill?.execute?.({ name: 'prescription-intake' })).toMatchObject({
      body: expect.stringContaining('references/clarification-checklist.md'),
    });
    expect(await wired?.tools.read_skill_resource?.execute?.({
      name: 'prescription-intake',
      path: 'references/clarification-checklist.md',
    })).toMatchObject({
      content: expect.stringContaining('Medicine name readable?'),
    });
  });

  it('protects knowledge while allowing durable notes', async () => {
    const notes = new InMemoryFs();
    const fs = createPharmacyWorkspace(notes);
    expect(await fs.readFile('/knowledge/policies/fulfilment.md')).toContain('Same-day delivery');
    await fs.mkdir('/notes/cases', { recursive: true });
    await fs.writeFile('/notes/cases/a.md', 'follow up');
    expect(await fs.readFile('/notes/cases/a.md')).toBe('follow up');
    await expect(fs.writeFile('/knowledge/policies/fulfilment.md', 'unsafe')).rejects.toThrow(/EROFS/);
  });
});
