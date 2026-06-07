import type { FileSystem } from '@kuralle-agents/core/types';
import type { SkillMeta, SkillStore } from '../types.js';
import { parseSkillMarkdown } from '../parseSkillMarkdown.js';

export class FsSkillStore implements SkillStore {
  private bodyCache = new Map<string, string>();
  private resourceCache = new Map<string, string | Uint8Array>();

  constructor(
    private readonly fs: FileSystem,
    private readonly root: string,
  ) {}

  async list(): Promise<SkillMeta[]> {
    const metas: SkillMeta[] = [];
    const entries = await this.fs.readdirWithFileTypes(this.root);
    for (const entry of entries) {
      if (entry.type !== 'directory') continue;
      const skillPath = this.fs.resolvePath(this.root, `${entry.name}/SKILL.md`);
      if (!(await this.fs.exists(skillPath))) continue;
      const md = await this.fs.readFile(skillPath);
      const parsed = parseSkillMarkdown(md, {
        path: skillPath,
        directoryName: entry.name,
      });
      metas.push({ name: parsed.name, description: parsed.description });
    }
    return metas.sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadBody(name: string): Promise<string> {
    const cached = this.bodyCache.get(name);
    if (cached !== undefined) return cached;
    const skillPath = await this.resolveSkillPath(name);
    const md = await this.fs.readFile(skillPath);
    const parsed = parseSkillMarkdown(md, { path: skillPath, directoryName: name });
    this.bodyCache.set(name, parsed.body);
    return parsed.body;
  }

  async loadResource(name: string, path: string): Promise<string | Uint8Array> {
    const cacheKey = `${name}:${path}`;
    const cached = this.resourceCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const normalized = path.trim().replace(/^\.?\//, '');
    if (normalized.includes('..') || normalized.startsWith('/')) {
      throw new Error(`[skills] Invalid resource path "${path}".`);
    }

    const resourcePath = this.fs.resolvePath(this.root, `${name}/${normalized}`);
    if (!(await this.fs.exists(resourcePath))) {
      throw new Error(`[skills] Resource "${normalized}" not found for skill "${name}".`);
    }

    const stat = await this.fs.stat(resourcePath);
    if (stat.type !== 'file') {
      throw new Error(`[skills] Resource "${normalized}" is not a file for skill "${name}".`);
    }

    const content =
      normalized.endsWith('.bin') || looksBinary(normalized)
        ? await this.fs.readFileBytes(resourcePath)
        : await this.fs.readFile(resourcePath);

    this.resourceCache.set(cacheKey, content);
    return content;
  }

  async loadAllSkills(): Promise<import('../types.js').Skill[]> {
    const metas = await this.list();
    const skills = [];
    for (const meta of metas) {
      const skillPath = await this.resolveSkillPath(meta.name);
      const md = await this.fs.readFile(skillPath);
      skills.push(
        parseSkillMarkdown(md, { path: skillPath, directoryName: meta.name }),
      );
    }
    return skills;
  }

  private async resolveSkillPath(name: string): Promise<string> {
    const skillPath = this.fs.resolvePath(this.root, `${name}/SKILL.md`);
    if (!(await this.fs.exists(skillPath))) {
      throw new Error(`[skills] Skill "${name}" not found.`);
    }
    return skillPath;
  }
}

function looksBinary(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|pdf|zip|bin)$/i.test(path);
}
