import { describe, expect, it } from 'bun:test';
import { CapabilityHost } from '@kuralle-agents/core/capabilities';
import { defineSkill } from '../src/defineSkill.js';
import { MemorySkillStore } from '../src/stores/memory.js';
import { SkillsCapability } from '@kuralle-agents/core';

describe('test:skill-capability', () => {
  const skill = defineSkill({
    name: 'returns-policy',
    description: 'Explains returns.',
    body: 'SECRET_BODY_TEXT',
    resources: { 'exceptions.md': 'SECRET_RESOURCE' },
  });

  it('prompt shows only name and description', async () => {
    const store = new MemorySkillStore([skill]);
    const metas = await store.list();
    const cap = new SkillsCapability(store, metas);
    const host = new CapabilityHost().use(cap);
    const prompt = host.getSystemPrompt('Base agent');
    expect(prompt).toContain('returns-policy: Explains returns.');
    expect(prompt).not.toContain('SECRET_BODY_TEXT');
    expect(prompt).not.toContain('SECRET_RESOURCE');
  });

  it('load_skill returns body and read_skill_resource returns resource', async () => {
    const store = new MemorySkillStore([skill]);
    const metas = await store.list();
    const cap = new SkillsCapability(store, metas);
    const tools = cap.getTools();
    const load = tools.find((t) => t.name === 'load_skill');
    const read = tools.find((t) => t.name === 'read_skill_resource');
    expect(load).toBeDefined();
    expect(read).toBeDefined();

    const bodyResult = await load!.execute({ name: 'returns-policy' });
    expect(bodyResult).toEqual({ body: 'SECRET_BODY_TEXT' });

    const resourceResult = await read!.execute({ name: 'returns-policy', path: 'exceptions.md' });
    expect(resourceResult).toEqual({ content: 'SECRET_RESOURCE' });

    expect(cap.processToolResult('load_skill', {}, bodyResult)).toBeNull();
  });
});
