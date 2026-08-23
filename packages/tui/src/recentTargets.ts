import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostedConfigPath } from '@kuralle-agents/client';

const MAX_RECENT = 8;

function recentTargetsPath(): string {
  return join(dirname(hostedConfigPath()), 'recent-targets.json');
}

export async function readRecentTargets(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(recentTargetsPath(), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function rememberTarget(target: string): Promise<void> {
  const normalized = target.trim();
  if (!normalized) return;
  const existing = await readRecentTargets();
  const next = [normalized, ...existing.filter((entry) => entry !== normalized)].slice(0, MAX_RECENT);
  const path = recentTargetsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
