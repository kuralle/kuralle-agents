import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineSkill } from '../src/defineSkill.js';
import { MemorySkillStore } from '../src/stores/memory.js';
import { BundledSkillStore } from '../src/stores/bundled.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('test:skill-stores', () => {
  const sample = defineSkill({
    name: 'returns-policy',
    description: 'Return policy guidance.',
    body: '# Returns\nRun lookup_order.',
    resources: { 'exceptions.md': '# Exceptions\nGift cards' },
    allowedTools: ['lookup_order'],
  });

  it('MemorySkillStore lists, loads body, and loads resources', async () => {
    const store = new MemorySkillStore([sample]);
    const metas = await store.list();
    expect(metas).toEqual([{ name: 'returns-policy', description: 'Return policy guidance.' }]);
    expect(await store.loadBody('returns-policy')).toContain('# Returns');
    expect(await store.loadResource('returns-policy', 'exceptions.md')).toContain('Gift cards');
  });

  it('BundledSkillStore lists and loads', async () => {
    const store = new BundledSkillStore({ 'returns-policy': sample });
    expect(await store.list()).toHaveLength(1);
    expect(await store.loadBody('returns-policy')).toContain('lookup_order');
  });

  it('memory and bundled stores have zero node:* imports', () => {
    const memorySrc = readFileSync(join(here, '../src/stores/memory.ts'), 'utf8');
    const bundledSrc = readFileSync(join(here, '../src/stores/bundled.ts'), 'utf8');
    expect(memorySrc).not.toMatch(/node:/);
    expect(bundledSrc).not.toMatch(/node:/);
  });
});
