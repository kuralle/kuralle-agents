import { describe, expect, it } from 'bun:test';
import { defineSkill, fsSkillStore } from '../../src/skills/index.js';
import { InMemoryFs } from '@kuralle-agents/fs';

describe('fsSkillStore discovery hardening', () => {
  it('skips a malformed SKILL.md and returns only the valid skill', async () => {
    const fs = new InMemoryFs({
      '/.agents/skills/broken/SKILL.md': '---\nname: broken\n---\nMissing description.',
      '/.agents/skills/good/SKILL.md': `---
name: good
description: A valid skill.
---

Good body.`,
    });

    const store = fsSkillStore(fs);
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    expect(metas[0]?.name).toBe('good');
    expect(await store.loadBody('good')).toBe('Good body.');
  });

  it('keys and loads resources by directory name when name agrees', async () => {
    const fs = new InMemoryFs({
      '/.agents/skills/foo/SKILL.md': `---
name: foo
description: Agrees with directory.
---

Foo body.`,
      '/.agents/skills/foo/references/x.md': '# Reference X',
    });

    const store = fsSkillStore(fs);
    const metas = await store.list();
    expect(metas).toHaveLength(1);
    expect(metas[0]?.name).toBe('foo');

    expect(await store.loadBody('foo')).toBe('Foo body.');
    expect(await store.loadResource('foo', 'references/x.md')).toBe('# Reference X');
  });

  it('defineSkill still throws on an invalid name', () => {
    expect(() =>
      defineSkill({ name: 'Not Valid', description: 'x', instructions: 'y' }),
    ).toThrow(/must match/);
  });
});
