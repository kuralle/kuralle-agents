import type { Skill, SkillSource, SkillStore } from './types.js';
import { MemorySkillStore } from './stores/memory.js';

export function isSkillStore(value: SkillSource): value is SkillStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'list' in value &&
    typeof (value as SkillStore).list === 'function'
  );
}

export function toSkillStore(source: SkillSource): SkillStore {
  if (isSkillStore(source)) return source;
  if (Array.isArray(source)) return new MemorySkillStore(source);
  return new MemorySkillStore([source as Skill]);
}
