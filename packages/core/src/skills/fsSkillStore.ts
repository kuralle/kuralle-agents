import type { FileSystem } from '../types/filesystem.js';
import type { SkillMeta, SkillStoreLike } from '../types/skills.js';
import { parseSkillFrontmatter } from './parseSkillFrontmatter.js';
import { sha256 } from './contentHash.js';

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
  let snapshot = new Map<string, SkillLocation>();
  let refresh: Promise<Map<string, SkillLocation>> | undefined;

  const discover = (): Promise<Map<string, SkillLocation>> => {
    refresh ??= discoverSkills(fs, roots).then((next) => {
      snapshot = next;
      return next;
    }).finally(() => {
      refresh = undefined;
    });
    return refresh;
  };

  const current = (name: string): SkillLocation | undefined => snapshot.get(name);

  return {
    async list(): Promise<SkillMeta[]> {
      const skills = await discover();
      return [...skills.values()]
        .map((skill) => skill.meta)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async loadBody(name: string): Promise<string> {
      const skill = current(name) ?? (await discover()).get(name);
      if (!skill) {
        throw new Error(`[skills] Skill "${name}" not found.`);
      }
      return skill.body;
    },

    async listResources(name: string): Promise<string[]> {
      const skill = current(name) ?? (await discover()).get(name);
      if (!skill) {
        throw new Error(`[skills] Skill "${name}" not found.`);
      }

      const skillDir = fs.resolvePath(skill.root, skill.folder);
      const paths: string[] = [];
      await collectResourcePaths(fs, skillDir, '', paths);
      return paths.sort();
    },

    async loadResource(name: string, path: string): Promise<string | Uint8Array> {
      const skill = current(name) ?? (await discover()).get(name);
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
        const parsed = parseSkillFrontmatter(content, { path: skillPath, directoryName: entry });
        const contentHash = await sha256(content);
        skills.set(entry, {
          root,
          folder: entry,
          meta: {
            name: parsed.name,
            description: parsed.description,
            path: skillPath,
            contentHash,
            ...(parsed.allowedTools ? { allowedTools: parsed.allowedTools } : {}),
          },
          body: parsed.body,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[skills] Skipping invalid skill "${entry}": ${message}`);
      }
    }
  }

  return skills;
}

async function collectResourcePaths(
  fs: FileSystem,
  dir: string,
  relPrefix: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdirWithFileTypes(dir);
  } catch {
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'SKILL.md') continue;
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.type === 'directory') {
      await collectResourcePaths(fs, fs.resolvePath(dir, entry.name), rel, out);
    } else if (entry.type === 'file') {
      out.push(rel);
    }
  }
}
