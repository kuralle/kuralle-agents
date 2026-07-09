import type { FileSystem, SkillMeta, SkillStoreLike } from '@kuralle-agents/core';
import { parseSkillFrontmatter } from './skill-frontmatter.js';

const DEFAULT_ROOT = '/skills';

export function fsSkillStore(fs: FileSystem, opts?: { root?: string }): SkillStoreLike {
  const root = opts?.root ?? DEFAULT_ROOT;

  return {
    async list(): Promise<SkillMeta[]> {
      const metas: SkillMeta[] = [];
      let entries: string[];
      try {
        entries = await fs.readdir(root);
      } catch {
        return metas;
      }

      for (const entry of entries) {
        const entryPath = fs.resolvePath(root, entry);
        let stat;
        try {
          stat = await fs.stat(entryPath);
        } catch {
          continue;
        }
        if (stat.type !== 'directory') continue;

        const skillPath = fs.resolvePath(root, `${entry}/SKILL.md`);
        if (!(await fs.exists(skillPath))) continue;

        try {
          const content = await fs.readFile(skillPath);
          const parsed = parseSkillFrontmatter(content, { path: skillPath });
          metas.push({ name: parsed.name, description: parsed.description });
        } catch (err) {
          console.warn(
            `[skills] Skipping ${skillPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return metas.sort((a, b) => a.name.localeCompare(b.name));
    },

    async loadBody(name: string): Promise<string> {
      const folder = await findSkillFolder(fs, root, name);
      if (!folder) {
        throw new Error(`[skills] Skill "${name}" not found.`);
      }
      const skillPath = fs.resolvePath(root, `${folder}/SKILL.md`);
      const content = await fs.readFile(skillPath);
      const parsed = parseSkillFrontmatter(content, { path: skillPath });
      return parsed.body;
    },

    async loadResource(name: string, path: string): Promise<string | Uint8Array> {
      const folder = await findSkillFolder(fs, root, name);
      if (!folder) {
        throw new Error(`[skills] Skill "${name}" not found.`);
      }

      const normalized = path.trim().replace(/^\.?\//, '');
      if (normalized.includes('..') || normalized.startsWith('/')) {
        throw new Error(`[skills] Invalid resource path "${path}".`);
      }

      const resourcePath = fs.resolvePath(root, `${folder}/${normalized}`);
      if (!(await fs.exists(resourcePath))) {
        const err = new Error(
          `ENOENT: [skills] Resource "${normalized}" not found for skill "${name}".`,
        );
        throw err;
      }

      return fs.readFile(resourcePath);
    },
  };
}

async function findSkillFolder(
  fs: FileSystem,
  root: string,
  name: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const entryPath = fs.resolvePath(root, entry);
    let stat;
    try {
      stat = await fs.stat(entryPath);
    } catch {
      continue;
    }
    if (stat.type !== 'directory') continue;

    const skillPath = fs.resolvePath(root, `${entry}/SKILL.md`);
    if (!(await fs.exists(skillPath))) continue;

    try {
      const content = await fs.readFile(skillPath);
      const parsed = parseSkillFrontmatter(content, { path: skillPath });
      if (parsed.name === name) return entry;
    } catch {
      continue;
    }
  }

  return null;
}