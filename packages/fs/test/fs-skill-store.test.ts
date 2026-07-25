import { describe, expect, it } from 'bun:test';
import { defineSkill, fsSkillStore, parseSkillFrontmatter } from '../src/index.js';
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

      expect(await store.list()).toEqual([
        { name: 'alpha', description: 'Project alpha.' },
        { name: 'beta', description: 'Base beta.' },
        { name: 'gamma', description: 'Project gamma.' },
      ]);
      expect(await store.loadBody('alpha')).toBe('Project alpha body.');
      expect(await store.loadResource('alpha', 'references/source.md')).toBe('project source');
      expect(await store.loadBody('beta')).toBe('Base beta body.');

      const reversed = fsSkillStore(fs, ['/skills/project', '/skills/base']);
      expect(await reversed.loadBody('alpha')).toBe('Base alpha body.');
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
