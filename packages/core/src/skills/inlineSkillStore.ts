import type { SkillLike, SkillMeta, SkillStoreLike } from '../types/skills.js';
import { canonicalSkillContent, sha256 } from './contentHash.js';

export class InlineSkillStore implements SkillStoreLike {
  private readonly byName: Map<string, SkillLike>;

  constructor(skills: SkillLike[]) {
    this.byName = new Map(skills.map((s) => [s.name, s]));
  }

  async list(): Promise<SkillMeta[]> {
    return Promise.all([...this.byName.values()].map(async (s) => ({
      name: s.name,
      description: s.description,
      contentHash: s.contentHash ?? await sha256(canonicalSkillContent(s)),
      ...(s.allowedTools ? { allowedTools: s.allowedTools } : {}),
      ...(s.path ? { path: s.path } : {}),
    })));
  }

  async loadBody(name: string): Promise<string> {
    const skill = this.byName.get(name);
    if (!skill) {
      throw new Error(`[skills] Skill "${name}" not found.`);
    }
    return skill.body;
  }

  async loadResource(name: string, path: string): Promise<string | Uint8Array> {
    const skill = this.byName.get(name);
    if (!skill) {
      throw new Error(`[skills] Skill "${name}" not found.`);
    }
    const normalized = path.trim().replace(/^\.?\//, '');
    if (normalized.includes('..') || normalized.startsWith('/')) {
      throw new Error(`[skills] Invalid resource path "${path}".`);
    }
    const content = skill.resources?.[normalized];
    if (content === undefined) {
      throw new Error(`[skills] Resource "${normalized}" not found for skill "${name}".`);
    }
    return content;
  }

  getAllSkills(): SkillLike[] {
    return [...this.byName.values()];
  }
}
