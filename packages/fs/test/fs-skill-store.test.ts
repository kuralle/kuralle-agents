import { describe, expect, it } from 'bun:test';
import { defineSkill, fsSkillStore, parseSkillFrontmatter } from '@kuralle-agents/core';
import { InMemoryFs } from '../src/in-memory-fs.js';

describe('test:fs-skill-store', () => {
  const validSkill = `---
name: alpha
description: Alpha skill instructions.
license: MIT
unknown-field: ignored
---

# Alpha body
Do alpha things.
`;

  describe('parseSkillFrontmatter', () => {
    it('accepts valid SKILL.md with name, description, body, and optional license', () => {
      const parsed = parseSkillFrontmatter(validSkill, { path: '/skills/alpha/SKILL.md' });
      expect(parsed.name).toBe('alpha');
      expect(parsed.description).toBe('Alpha skill instructions.');
      expect(parsed.license).toBe('MIT');
      expect(parsed.body).toBe('# Alpha body\nDo alpha things.\n');
    });

    it('rejects missing frontmatter', () => {
      expect(() => parseSkillFrontmatter('# no frontmatter', { path: 'SKILL.md' })).toThrow(
        /missing YAML frontmatter/,
      );
    });

    it('rejects missing name', () => {
      const md = `---\ndescription: only desc\n---\nbody`;
      expect(() => parseSkillFrontmatter(md, { path: 'SKILL.md' })).toThrow(/frontmatter name/);
    });

    it('rejects missing description', () => {
      const md = `---\nname: ok\n---\nbody`;
      expect(() => parseSkillFrontmatter(md, { path: 'SKILL.md' })).toThrow(/frontmatter description/);
    });

    it('rejects name longer than 64 characters', () => {
      const md = `---\nname: ${'a'.repeat(65)}\ndescription: ok\n---\nbody`;
      expect(() => parseSkillFrontmatter(md, { path: 'SKILL.md' })).toThrow(/at most 64/);
    });

    it('rejects description longer than 1024 characters', () => {
      const md = `---\nname: short\ndescription: ${'x'.repeat(1025)}\n---\nbody`;
      expect(() => parseSkillFrontmatter(md, { path: 'SKILL.md' })).toThrow(/1024/);
    });

    it('ignores unknown frontmatter fields', () => {
      const parsed = parseSkillFrontmatter(validSkill, { path: 'SKILL.md' });
      expect(parsed).not.toHaveProperty('unknown-field');
      expect(parsed.name).toBe('alpha');
    });
  });

  describe('fsSkillStore', () => {
    it('lists skills, loads body and resources, and blocks path traversal', async () => {
      const fs = new InMemoryFs({
        '/skills/alpha/SKILL.md': validSkill,
        '/skills/beta/SKILL.md': `---
name: beta
description: Beta skill.
---

Beta body content.`,
        '/skills/alpha/references/x.md': '# Reference X',
        '/skills/empty-dir/.gitkeep': '',
      });

      const store = fsSkillStore(fs);

      const metas = await store.list();
      expect(metas).toHaveLength(2);
      expect(metas.map((m) => m.name).sort()).toEqual(['alpha', 'beta']);

      expect(await store.loadBody('alpha')).toBe('# Alpha body\nDo alpha things.\n');
      expect(await store.loadResource('alpha', 'references/x.md')).toBe('# Reference X');

      await expect(store.loadResource('alpha', '../etc')).rejects.toThrow(/Invalid resource path/);
    });

    it('layers ordered roots with last-one-wins collisions', async () => {
      const fs = new InMemoryFs({
        '/skills/base/alpha/SKILL.md': `---
name: alpha
description: Base alpha.
---

Base alpha body.`,
        '/skills/base/alpha/references/source.md': 'base source',
        '/skills/base/beta/SKILL.md': `---
name: beta
description: Base beta.
---

Base beta body.`,
        '/skills/project/alpha/SKILL.md': `---
name: alpha
description: Project alpha.
---

Project alpha body.`,
        '/skills/project/alpha/references/source.md': 'project source',
        '/skills/project/gamma/SKILL.md': `---
name: gamma
description: Project gamma.
---

Project gamma body.`,
      });

      const store = fsSkillStore(fs, ['/skills/base', '/skills/project']);

      // SkillMeta now also carries `path` — the SKILL.md location, surfaced in the
      // available-skills catalog so the model can read the file rather than infer it.
      // Assert it explicitly rather than loosening the check: `alpha` must resolve to the
      // PROJECT root (last-one-wins), `beta` to the base root, which is exactly what this
      // test is about and is now pinned more tightly than before.
      const listed = await store.list();
      expect(listed).toMatchObject([
        { name: 'alpha', description: 'Project alpha.' },
        { name: 'beta', description: 'Base beta.' },
        { name: 'gamma', description: 'Project gamma.' },
      ]);
      // The winning root is visible in the path, which the old toEqual could not express.
      expect(String(listed[0]?.path)).toContain('alpha');
      expect(String(listed[1]?.path)).toContain('beta');
      expect(listed.every((m) => typeof m.path === 'string' && m.path.endsWith('SKILL.md'))).toBe(true);
      expect(await store.loadBody('alpha')).toBe('Project alpha body.');
      expect(await store.loadResource('alpha', 'references/source.md')).toBe('project source');
      expect(await store.loadBody('beta')).toBe('Base beta body.');

      const reversed = fsSkillStore(fs, ['/skills/project', '/skills/base']);
      expect(await reversed.loadBody('alpha')).toBe('Base alpha body.');
    });

    it('fails loudly when a discovered SKILL.md is invalid', async () => {
      const fs = new InMemoryFs({
        '/skills/broken/SKILL.md': '---\nname: broken\n---\nMissing description.',
      });

      await expect(fsSkillStore(fs).list()).rejects.toThrow(/broken\/SKILL\.md.*description/i);
    });

    it('reuses one validated discovery snapshot across catalog and body loads', async () => {
      const fs = new InMemoryFs({ '/skills/alpha/SKILL.md': validSkill });
      const originalRead = fs.readFile.bind(fs);
      let reads = 0;
      fs.readFile = async (...args) => {
        reads += 1;
        return originalRead(...args);
      };

      const store = fsSkillStore(fs);
      await store.list();
      await store.loadBody('alpha');
      await store.loadBody('alpha');
      expect(reads).toBe(1);
    });

    it('refreshes on the next catalog snapshot and keys it by content hash', async () => {
      const fs = new InMemoryFs({ '/skills/alpha/SKILL.md': validSkill });
      const store = fsSkillStore(fs);

      const first = (await store.list())[0]!;
      expect(await store.loadBody('alpha')).toContain('Do alpha things.');

      await fs.writeFile('/skills/alpha/SKILL.md', `---
name: alpha
description: Updated alpha instructions.
---

# Updated body
Do the new thing.
`);

      const second = (await store.list())[0]!;
      expect(second.description).toBe('Updated alpha instructions.');
      expect(second.contentHash).not.toBe(first.contentHash);
      expect(await store.loadBody('alpha')).toContain('Do the new thing.');
    });

    it('preserves allowed-tools enforcement metadata outside the model catalog', async () => {
      const fs = new InMemoryFs({
        '/skills/alpha/SKILL.md': `---
name: alpha
description: Alpha skill instructions.
allowed-tools: [lookup, checkout]
---

Use the registered tools.`,
      });

      const meta = (await fsSkillStore(fs).list())[0]!;
      expect(meta.allowedTools).toEqual(['lookup', 'checkout']);
      expect(meta.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('defineSkill', () => {
    it('returns SkillLike with body equal to instructions', () => {
      const skill = defineSkill({
        name: 'inline',
        description: 'Inline skill',
        instructions: 'Do the thing.',
        resources: { 'ref.md': '# Ref' },
      });
      expect(skill.name).toBe('inline');
      expect(skill.description).toBe('Inline skill');
      expect(skill.body).toBe('Do the thing.');
      expect(skill.resources).toEqual({ 'ref.md': '# Ref' });
    });
  });
});
