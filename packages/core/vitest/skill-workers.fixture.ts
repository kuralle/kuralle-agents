import { defineSkill } from '../src/skills/defineSkill.js';
import { InlineSkillStore } from '../src/skills/inlineSkillStore.js';
import { fsSkillStore } from '../src/skills/fsSkillStore.js';
import { prepareSkillStore } from '../src/skills/collectSkills.js';
import type { FileSystem } from '../src/types/filesystem.js';

export const SKILL_BODY = 'WORKERS_BODY_BYTES';
export const SKILL_RESOURCE = 'WORKERS_RESOURCE_BYTES';
export const FS_SKILL_BODY = 'FS_WORKERS_BODY_BYTES';

const skill = defineSkill({
  name: 'returns-policy',
  description: 'Return policy for support.',
  instructions: SKILL_BODY,
  resources: { 'exceptions.md': SKILL_RESOURCE },
});

export async function runInlineRoundTrip(): Promise<{ body: string; resource: string }> {
  const store = new InlineSkillStore([skill]);
  const body = await store.loadBody('returns-policy');
  const resource = await store.loadResource('returns-policy', 'exceptions.md');
  return {
    body,
    resource: typeof resource === 'string' ? resource : new TextDecoder().decode(resource),
  };
}

/** Minimal FileSystem — proves the store and parser need no Node built-ins. */
function memFs(files: Record<string, string>): FileSystem {
  const norm = (p: string) => p.replace(/\/+$/, '');
  return {
    async readdir(dir: string) {
      const prefix = `${norm(dir)}/`;
      const names = new Set<string>();
      for (const path of Object.keys(files)) {
        if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('/')[0]!);
      }
      if (names.size === 0) throw new Error(`ENOENT: ${dir}`);
      return [...names];
    },
    async stat(path: string) {
      const p = norm(path);
      if (files[p]) return { type: 'file' as const, size: files[p]!.length };
      if (Object.keys(files).some((f) => f.startsWith(`${p}/`))) {
        return { type: 'directory' as const, size: 0 };
      }
      throw new Error(`ENOENT: ${path}`);
    },
    async exists(path: string) {
      const p = norm(path);
      return files[p] !== undefined || Object.keys(files).some((f) => f.startsWith(`${p}/`));
    },
    async readFile(path: string) {
      const content = files[norm(path)];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    resolvePath: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
  } as unknown as FileSystem;
}

/** Exercises the SKILL.md parser and the fs-backed store inside workerd. */
export async function runFsRoundTrip(): Promise<{ names: string[]; body: string }> {
  const fs = memFs({
    '/skills/returns-policy/SKILL.md': `---\nname: returns-policy\ndescription: Return policy for support.\n---\n\n${FS_SKILL_BODY}\n`,
  });
  const store = fsSkillStore(fs, ['/skills']);
  return {
    names: (await store.list()).map((m) => m.name),
    body: (await store.loadBody('returns-policy')).trim(),
  };
}

/** Path-string resolution must work on workerd too, not just Node. */
export async function runPathSourceRoundTrip(): Promise<string[]> {
  const fs = memFs({
    '/skills/returns-policy/SKILL.md': `---\nname: returns-policy\ndescription: Return policy for support.\n---\n\n${FS_SKILL_BODY}\n`,
  });
  const { skills } = await prepareSkillStore(['/skills'], fs);
  return skills.map((s) => s.name);
}
