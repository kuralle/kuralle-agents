import type { Skill } from './types.js';
import { validateSkillFields } from './validateSkill.js';

export function defineSkill(skill: Skill): Skill {
  validateSkillFields(skill, { path: skill.name });
  return skill;
}
