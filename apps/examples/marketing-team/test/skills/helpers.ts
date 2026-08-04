import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackagedSkill } from '@kuralle-agents/core';
import { packageSkillsDirectory } from '@kuralle-agents/build';

const AGENT_DIR = join(import.meta.dir, '../../agent');

/**
 * Every `<something>/skills/` directory under `agent/`, walked from the filesystem rather
 * than hand-listed — a specialist (or the shared `agent/shared/skills/`) added later is
 * picked up automatically, and a specialist that loses its `skills/` dir drops out on its
 * own instead of a stale entry silently packaging nothing.
 */
export async function discoverSkillRoots(): Promise<string[]> {
  const entries = await readdir(AGENT_DIR, { withFileTypes: true });
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillsDir = join(AGENT_DIR, entry.name, 'skills');
    const children = await readdir(skillsDir, { withFileTypes: true }).catch(() => undefined);
    if (!children) continue;
    if (children.some((c) => c.isDirectory())) roots.push(skillsDir);
  }
  return roots.sort();
}

/** Packages every discovered root and flattens the result into one list. */
export async function packageAllSkills(): Promise<PackagedSkill[]> {
  const roots = await discoverSkillRoots();
  const packaged = await Promise.all(roots.map((root) => packageSkillsDirectory(root)));
  return packaged.flat();
}
