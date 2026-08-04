import type { SkillMeta, SkillStoreLike } from '../types/skills.js';
import { assertSafeSkillResourcePath } from './assertSafeSkillResourcePath.js';
import { parseSkillFrontmatter } from './parseSkillFrontmatter.js';
import type { PackagedSkill } from './packagedSkill.js';

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function packagedSkillStore(packages: readonly PackagedSkill[]): SkillStoreLike {
  const byName = new Map<string, PackagedSkill>(packages.map((pkg) => [pkg.name, pkg]));

  return {
    async list(): Promise<SkillMeta[]> {
      return [...byName.values()]
        .map((pkg) => ({
          name: pkg.name,
          description: pkg.description,
          contentHash: pkg.id,
          ...(pkg.allowedTools ? { allowedTools: [...pkg.allowedTools] } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async loadBody(name: string): Promise<string> {
      const pkg = byName.get(name);
      if (!pkg) {
        throw new Error(`[skills] Skill "${name}" not found.`);
      }
      const skillFile = pkg.files['SKILL.md'];
      if (!skillFile) {
        throw new Error(`[skills] Skill "${name}" is missing SKILL.md.`);
      }
      const raw = new TextDecoder('utf-8').decode(decodeBase64(skillFile.content));
      const parsed = parseSkillFrontmatter(raw, { path: 'SKILL.md', directoryName: pkg.name });
      return parsed.body;
    },

    async listResources(name: string): Promise<string[]> {
      const pkg = byName.get(name);
      if (!pkg) {
        throw new Error(`[skills] Skill "${name}" not found.`);
      }
      return Object.keys(pkg.files)
        .filter((path) => path !== 'SKILL.md')
        .sort();
    },

    async loadResource(name: string, path: string): Promise<string | Uint8Array> {
      const pkg = byName.get(name);
      if (!pkg) {
        throw new Error(`[skills] Skill "${name}" not found.`);
      }
      const normalized = assertSafeSkillResourcePath(path);
      const file = pkg.files[normalized];
      if (!file) {
        throw new Error(`[skills] Resource "${normalized}" not found for skill "${name}".`);
      }
      const bytes = decodeBase64(file.content);
      if (file.kind === 'text') {
        return new TextDecoder('utf-8').decode(bytes);
      }
      return bytes;
    },
  };
}
