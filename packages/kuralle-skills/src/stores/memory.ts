import type { Skill, SkillMeta, SkillStore } from '../types.js';
import { defineSkill } from '../defineSkill.js';

export class MemorySkillStore implements SkillStore {
  private readonly byName: Map<string, Skill>;

  constructor(skills: Skill[]) {
    this.byName = new Map();
    for (const skill of skills) {
      const validated = defineSkill(skill);
      this.byName.set(validated.name, validated);
    }
  }

  async list(): Promise<SkillMeta[]> {
    return [...this.byName.values()].map((s) => ({
      name: s.name,
      description: s.description,
    }));
  }

  async loadBody(name: string): Promise<string> {
    const skill = this.requireSkill(name);
    return skill.body;
  }

  async loadResource(name: string, path: string): Promise<string | Uint8Array> {
    const skill = this.requireSkill(name);
    const normalized = normalizeResourcePath(path);
    const content = skill.resources?.[normalized];
    if (content === undefined) {
      throw new Error(`[skills] Resource "${normalized}" not found for skill "${name}".`);
    }
    return content;
  }

  getAllSkills(): Skill[] {
    return [...this.byName.values()];
  }

  private requireSkill(name: string): Skill {
    const skill = this.byName.get(name);
    if (!skill) {
      throw new Error(`[skills] Skill "${name}" not found.`);
    }
    return skill;
  }
}

function normalizeResourcePath(path: string): string {
  const trimmed = path.trim().replace(/^\.?\//, '');
  if (trimmed.includes('..') || trimmed.startsWith('/')) {
    throw new Error(`[skills] Invalid resource path "${path}".`);
  }
  return trimmed;
}
