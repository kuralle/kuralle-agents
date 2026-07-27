import type { FileSystem } from '../types/filesystem.js';
import type { SkillMeta, SkillStoreLike } from '../types/skills.js';
import { parseSkillFrontmatter } from './parseSkillFrontmatter.js';

const DEFAULT_ROOT = '/skills';

interface SkillLocation {
  root: string;
  folder: string;
  meta: SkillMeta;
  body: string;
}

export function fsSkillStore(
  fs: FileSystem,
  orderedRoots: readonly string[] = [DEFAULT_ROOT],
): SkillStoreLike {
  const roots = [...orderedRoots];

  return {
    async list(): Promise<SkillMeta[]> {
      const skills = await discoverSkills(fs, roots, true);
      return [...skills.values()]
        .map((skill) => skill.meta)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async loadBody(name: string): Promise<string> {
      const skill = (await discoverSkills(fs, roots, false)).get(name);
      if (!skill) {
        throw new Error(`[skills] Skill "${name}" not found.`);
      }
      return skill.body;
    },

    async loadResource(name: string, path: string): Promise<string | Uint8Array> {
      const skill = (await discoverSkills(fs, roots, false)).get(name);
      if (!skill) {
        throw new Error(`[skills] Skill "${name}" not found.`);
      }

      const normalized = path.trim().replace(/^\.?\//, '');
      if (normalized.includes('..') || normalized.startsWith('/')) {
        throw new Error(`[skills] Invalid resource path "${path}".`);
      }

      const resourcePath = fs.resolvePath(skill.root, `${skill.folder}/${normalized}`);
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

async function discoverSkills(
  fs: FileSystem,
  roots: readonly string[],
  warnInvalid: boolean,
): Promise<Map<string, SkillLocation>> {
  const skills = new Map<string, SkillLocation>();

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }

    for (const entry of entries.sort()) {
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
        skills.set(parsed.name, {
          root,
          folder: entry,
          meta: { name: parsed.name, description: parsed.description, path: skillPath },
          body: parsed.body,
        });
      } catch (err) {
        if (warnInvalid) {
          console.warn(
            `[skills] Skipping ${skillPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  return skills;
}
