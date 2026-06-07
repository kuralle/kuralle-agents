import { MemorySkillStore } from '../src/stores/memory.js';
import { defineSkill } from '../src/defineSkill.js';

const skill = defineSkill({
  name: 'returns-policy',
  description: 'Return policy for support.',
  body: 'WORKERS_BODY_BYTES',
  resources: { 'exceptions.md': 'WORKERS_RESOURCE_BYTES' },
});

const store = new MemorySkillStore([skill]);

export async function runSkillRoundTrip(): Promise<{
  body: string;
  resource: string;
}> {
  const body = await store.loadBody('returns-policy');
  const resource = await store.loadResource('returns-policy', 'exceptions.md');
  return {
    body,
    resource: typeof resource === 'string' ? resource : new TextDecoder().decode(resource),
  };
}

export const NODE_SKILL_BODY = 'WORKERS_BODY_BYTES';
export const NODE_SKILL_RESOURCE = 'WORKERS_RESOURCE_BYTES';
