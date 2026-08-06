import { defineSkill } from '../src/skills/defineSkill.js';
import { InlineSkillStore } from '../src/skills/inlineSkillStore.js';
import { fsSkillStore } from '../src/skills/fsSkillStore.js';
import { prepareSkillStore } from '../src/skills/collectSkills.js';
import { brandPackagedSkill, classifySkillFileKind } from '../src/skills/packagedSkill.js';
import { packagedSkillStore } from '../src/skills/packagedSkillStore.js';
import type { FileSystem } from '../src/types/filesystem.js';

export const SKILL_BODY = 'WORKERS_BODY_BYTES';
export const SKILL_RESOURCE = 'WORKERS_RESOURCE_BYTES';
export const FS_SKILL_BODY = 'FS_WORKERS_BODY_BYTES';
export const PACKAGED_BINARY_BYTES = new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x02]);

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Packaged skills with a binary resource must load on workerd. */
export async function runPackagedRoundTrip(): Promise<{ body: string; resource: Uint8Array }> {
  const skillMd = `---\nname: packaged-demo\ndescription: Packaged on workerd.\n---\n\nPACKAGED_BODY`;
  const pkg = brandPackagedSkill({
    id: 'skill:packaged-demo:workerd',
    name: 'packaged-demo',
    description: 'Packaged on workerd.',
    files: {
      'SKILL.md': {
        path: 'SKILL.md',
        encoding: 'base64',
        kind: 'text',
        content: bytesToBase64(new TextEncoder().encode(skillMd)),
      },
      'data.bin': {
        path: 'data.bin',
        encoding: 'base64',
        kind: classifySkillFileKind(PACKAGED_BINARY_BYTES),
        content: bytesToBase64(PACKAGED_BINARY_BYTES),
      },
    },
  });
  const store = packagedSkillStore([pkg]);
  const body = await store.loadBody('packaged-demo');
  const resource = await store.loadResource('packaged-demo', 'data.bin');
  if (!(resource instanceof Uint8Array)) {
    throw new Error('Expected binary resource to be Uint8Array');
  }
  return { body, resource };
}
