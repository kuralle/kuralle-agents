import { describe, expect, it } from 'bun:test';
import { SkillsCapability } from '../../src/skills/SkillsCapability.js';
import { InlineSkillStore } from '../../src/skills/inlineSkillStore.js';
import { fsSkillStore } from '../../src/skills/fsSkillStore.js';
import { LiveSkillCatalog } from '../../src/skills/liveSkillCatalog.js';
import { InMemoryFs } from '@kuralle-agents/fs';

function getTool<T extends { execute?: (...args: never[]) => unknown }>(
  cap: SkillsCapability,
  name: string,
): T {
  const tool = cap.getTools().find((t) => t.name === name);
  if (!tool?.execute) throw new Error(`missing tool ${name}`);
  return tool as T;
}

describe('skill load briefing', () => {
  it('briefing lists two resources with read_skill_resource call shape and skill name', async () => {
    const store = new InlineSkillStore([
      {
        name: 'checklist-skill',
        description: 'Uses references.',
        body: 'Follow the checklist.',
        resources: {
          'references/checklist.md': '# Checklist',
          'references/guide.md': '# Guide',
        },
      },
    ]);
    const cap = new SkillsCapability(
      new LiveSkillCatalog(store, [{ name: 'checklist-skill', description: 'Uses references.' }]),
    );
    const loadSkill = getTool<{ execute: (args: { name: string }) => Promise<string> }>(
      cap,
      'load_skill',
    );

    const briefing = await loadSkill.execute({ name: 'checklist-skill' });

    expect(briefing).toContain('references/checklist.md');
    expect(briefing).toContain('references/guide.md');
    expect(briefing).toContain(
      'read_skill_resource { name: "checklist-skill", path: "references/checklist.md" }',
    );
    expect(briefing).toContain(
      'read_skill_resource { name: "checklist-skill", path: "references/guide.md" }',
    );
    expect(briefing).toContain('Run the skill named "checklist-skill".');
    expect(briefing).toContain('<skill_instructions>');
    expect(briefing).toContain('Follow the checklist.');
    expect(briefing).toContain('</skill_instructions>');
  });

  it('briefing omits skill_resources when there are no resources', async () => {
    const store = new InlineSkillStore([
      { name: 'bare-skill', description: 'No files.', body: 'Just instructions.' },
    ]);
    const cap = new SkillsCapability(
      new LiveSkillCatalog(store, [{ name: 'bare-skill', description: 'No files.' }]),
    );
    const loadSkill = getTool<{ execute: (args: { name: string }) => Promise<string> }>(
      cap,
      'load_skill',
    );

    const briefing = await loadSkill.execute({ name: 'bare-skill' });

    expect(briefing).not.toContain('<skill_resources>');
    expect(briefing).not.toContain('Supporting skill resources');
    expect(briefing).toContain('Just instructions.');
  });

  it('load_skill with unknown name resolves to available skill names', async () => {
    const store = new InlineSkillStore([
      { name: 'alpha', description: 'A', body: 'a' },
      { name: 'beta', description: 'B', body: 'b' },
    ]);
    const cap = new SkillsCapability(
      new LiveSkillCatalog(store, [
        { name: 'alpha', description: 'A' },
        { name: 'beta', description: 'B' },
      ]),
    );
    const loadSkill = getTool<{ execute: (args: { name: string }) => Promise<string> }>(
      cap,
      'load_skill',
    );

    const result = await loadSkill.execute({ name: 'missing' });

    expect(result).toBe('Skill "missing" is not available. Available skills: alpha, beta.');
  });

  it('load_skill with unknown name and empty catalog resolves to no-skills wording', async () => {
    const store = new InlineSkillStore([]);
    const cap = new SkillsCapability(new LiveSkillCatalog(store, []));
    const loadSkill = getTool<{ execute: (args: { name: string }) => Promise<string> }>(
      cap,
      'load_skill',
    );

    const result = await loadSkill.execute({ name: 'missing' });

    expect(result).toBe('Skill "missing" is not available. No skills are available.');
  });

  it('read_skill_resource with unknown path resolves to readable resource list', async () => {
    const store = new InlineSkillStore([
      {
        name: 'docs-skill',
        description: 'Docs.',
        body: 'Read docs.',
        resources: { 'references/a.md': 'A', 'templates/b.md': 'B' },
      },
    ]);
    const cap = new SkillsCapability(
      new LiveSkillCatalog(store, [{ name: 'docs-skill', description: 'Docs.' }]),
    );
    const readResource = getTool<{
      execute: (args: { name: string; path: string }) => Promise<string | { content: string }>;
    }>(cap, 'read_skill_resource');

    const result = await readResource.execute({ name: 'docs-skill', path: 'missing.md' });

    expect(result).toBe(
      'Resource "missing.md" is not available for skill "docs-skill". Readable resources: references/a.md, templates/b.md.',
    );
  });

  it('inlineSkillStore.loadResource treats SKILL.md as a miss, not a resource', async () => {
    const store = new InlineSkillStore([
      {
        name: 'inline',
        description: 'Inline.',
        body: 'Body.',
        resources: { 'SKILL.md': 'should-not-serve' },
      },
    ]);

    await expect(store.loadResource('inline', 'SKILL.md')).rejects.toThrow(/not found for skill/);
  });

  it('read_skill_resource rejects traversal paths', async () => {
    const store = {
      list: async () => [],
      loadBody: async () => '',
      loadResource: async () => 'must-not-reach',
      listResources: async () => [],
    };
    const cap = new SkillsCapability(
      new LiveSkillCatalog(store as never, [{ name: 'secure-skill', description: 'Secure.' }]),
    );
    const readResource = getTool<{
      execute: (args: { name: string; path: string }) => Promise<unknown>;
    }>(cap, 'read_skill_resource');

    await expect(
      readResource.execute({ name: 'secure-skill', path: '../secret' }),
    ).rejects.toThrow(/Invalid resource path/);
  });

  it('fsSkillStore.listResources returns nested paths sorted and excludes SKILL.md', async () => {
    const fs = new InMemoryFs({
      '/.agents/skills/nested/SKILL.md': `---
name: nested
description: Nested resources.
---

Body.`,
      '/.agents/skills/nested/references/b.md': '# B',
      '/.agents/skills/nested/references/a.md': '# A',
      '/.agents/skills/nested/templates/t.md': '# T',
    });

    const store = fsSkillStore(fs);
    const resources = await store.listResources!('nested');

    expect(resources).toEqual(['references/a.md', 'references/b.md', 'templates/t.md']);
    expect(resources).not.toContain('SKILL.md');
  });

  it('fsSkillStore.loadResource treats SKILL.md as a miss, not a resource', async () => {
    const fs = new InMemoryFs({
      '/.agents/skills/nested/SKILL.md': `---
name: nested
description: Nested resources.
---

Body.`,
    });

    const store = fsSkillStore(fs);
    await expect(store.loadResource('nested', 'SKILL.md')).rejects.toThrow(/not found for skill/);
  });
});
