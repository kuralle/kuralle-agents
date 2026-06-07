import { describe, expect, it } from 'bun:test';
import { InMemoryFs } from '@kuralle-agents/fs';
import { FsSkillStore } from '../src/stores/fs.js';

describe('test:skill-fsstore', () => {
  it('lists */SKILL.md from InMemoryFs and loads body/resource', async () => {
    const fs = new InMemoryFs({
      '/skills/returns-policy/SKILL.md': `---
name: returns-policy
description: Return policy for support.
allowed-tools: lookup_order
---
# Returns
Use lookup_order.`,
      '/skills/returns-policy/exceptions.md': '# Gift cards are non-returnable',
    });

    const store = new FsSkillStore(fs, '/skills');
    const metas = await store.list();
    expect(metas).toEqual([
      { name: 'returns-policy', description: 'Return policy for support.' },
    ]);

    expect(await store.loadBody('returns-policy')).toContain('# Returns');
    expect(await store.loadResource('returns-policy', 'exceptions.md')).toContain('Gift cards');
  });
});
