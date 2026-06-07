import type { SkillSource as CoreSkillSource, SkillLike } from '@kuralle-agents/core/types';
import type { Skill, SkillSource } from './types.js';
import { BundledSkillStore } from './stores/bundled.js';
import { FsSkillStore } from './stores/fs.js';
import { MemorySkillStore } from './stores/memory.js';
import { toSkillStore, isSkillStore } from './toSkillStore.js';

export type { SkillWireAgent } from '@kuralle-agents/core';
export {
  collectRegisteredNames,
  validateSkillAllowedTools,
} from '@kuralle-agents/core';

export async function collectSkillsFromSource(source: SkillSource): Promise<Skill[]> {
  if (!isSkillStore(source)) {
    return Array.isArray(source) ? source : [source];
  }
  if (source instanceof MemorySkillStore || source instanceof BundledSkillStore) {
    return source.getAllSkills();
  }
  if (source instanceof FsSkillStore) {
    return source.loadAllSkills();
  }
  const metas = await source.list();
  const skills: Skill[] = [];
  for (const meta of metas) {
    const body = await source.loadBody(meta.name);
    skills.push({ name: meta.name, description: meta.description, body });
  }
  return skills;
}

export async function collectSkillsFromAgent(agent: {
  skills?: CoreSkillSource;
}): Promise<SkillLike[]> {
  if (!agent.skills) return [];
  return collectSkillsFromSource(agent.skills as SkillSource);
}

export async function prepareSkillStore(source: SkillSource): Promise<{
  store: ReturnType<typeof toSkillStore>;
  skills: Skill[];
}> {
  const store = toSkillStore(source);
  const skills = await collectSkillsFromSource(source);
  return { store, skills };
}
