import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ReleaseAgentConfig } from './types.js';

const fileSchema = z.object({
  checks: z.array(z.object({
    name: z.string().min(1).max(100),
    command: z.tuple([z.string().min(1)]).rest(z.string()),
  })).min(1).max(20),
});

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function loadReleaseAgentConfig(): Promise<ReleaseAgentConfig> {
  const appRoot = resolve(import.meta.dirname, '..');
  const repoRoot = await realpath(resolve(process.env.RELEASE_REPO_ROOT?.trim() || resolve(appRoot, '../../..')));
  const stateRoot = resolve(process.env.RELEASE_STATE_ROOT?.trim() || resolve(appRoot, 'runs/workspace'));
  const configPath = resolve(process.env.RELEASE_CONFIG_PATH?.trim() || resolve(appRoot, 'release-agent.config.json'));
  const parsed = fileSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const repository = process.env.GITHUB_REPOSITORY?.trim() || 'kuralle/kuralle-agents';
  if (!repositoryPattern.test(repository)) throw new Error('GITHUB_REPOSITORY must be an exact owner/repository slug.');
  const releaseBranch = process.env.RELEASE_BRANCH?.trim() || 'main';
  if (!/^[A-Za-z0-9._/-]+$/.test(releaseBranch) || releaseBranch.includes('..')) {
    throw new Error('RELEASE_BRANCH contains unsupported characters.');
  }
  return {
    repoRoot,
    stateRoot,
    repository,
    releaseBranch,
    checks: parsed.checks.map((check) => ({ name: check.name, command: check.command as [string, ...string[]] })),
  };
}
