import type { Skill, SkillMeta, SkillStore } from '../types.js';
import { defineSkill } from '../defineSkill.js';

export class BundledSkillStore implements SkillStore {
  private readonly byName: Map<string, Skill>;

  constructor(record: Record<string, Skill>) {
    this.byName = new Map();
    for (const [key, skill] of Object.entries(record)) {
      const validated = defineSkill(skill);
      if (validated.name !== key) {
        throw new Error(
          `[skills] Bundled skill key "${key}" does not match skill name "${validated.name}".`,
        );
      }
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
    const normalized = path.trim().replace(/^\.?\//, '');
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
