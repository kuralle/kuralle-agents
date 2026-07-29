import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { buildReleaseGovernanceAgent, releasePolicy } from '../src/agent.js';
import type { ReleaseAgentConfig } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kuralle-release-agent-contract-'));
  roots.push(root);
  const skills = join(root, 'skills', 'release-governance');
  await mkdir(skills, { recursive: true });
  await writeFile(join(skills, 'SKILL.md'), '---\nname: release-governance\ndescription: Govern a release.\n---\n\n# Release\n');
  await writeFile(join(root, '.env'), 'GITHUB_TOKEN=must-not-be-visible\n');
  await writeFile(join(root, '.env.example'), 'GITHUB_TOKEN=\n');
  await symlink('.env', join(root, 'innocent-looking-link'));
  const config: ReleaseAgentConfig = {
    repoRoot: root,
    stateRoot: join(root, 'output'),
    repository: 'acme/widgets',
    releaseBranch: 'main',
    checks: [{ name: 'check', command: [process.execPath, '-e', ''] }],
  };
  return buildReleaseGovernanceAgent({ model: {} as LanguageModel, config, skillRoot: root });
}

describe('release governance agent contract', () => {
  it('uses a writable composite workspace while the repository mount remains immutable', async () => {
    const agent = await fixture();
    expect(agent.workspace).toMatchObject({ readOnly: false, modelWritable: true });
    const workspace = (agent.workspace as { fs: { writeFile(path: string, content: string): Promise<void>; readFile(path: string): Promise<string> } }).fs;
    await expect(workspace.writeFile('/repo/changed.txt', 'no')).rejects.toThrow();
    await workspace.writeFile('/output/note.md', '# Review\n');
    expect(await workspace.readFile('/output/note.md')).toBe('# Review\n');
  });

  it('removes credential files and aliases from the repository view', async () => {
    const agent = await fixture();
    const workspace = (agent.workspace as { fs: {
      readFile(path: string): Promise<string>;
      readdir(path: string): Promise<string[]>;
      glob(pattern: string): Promise<string[]>;
    } }).fs;
    expect(await workspace.readFile('/repo/.env.example')).toBe('GITHUB_TOKEN=\n');
    await expect(workspace.readFile('/repo/.env')).rejects.toThrow(/private repository path/);
    await expect(workspace.readFile('/repo/innocent-looking-link')).rejects.toThrow(/private repository path/);
    expect(await workspace.readdir('/repo')).not.toContain('.env');
    expect(await workspace.readdir('/repo')).not.toContain('innocent-looking-link');
    expect(await workspace.glob('**')).toContain('/repo/.env.example');
    expect(await workspace.glob('**')).not.toContain('/repo/.env');
    expect(await workspace.glob('**')).not.toContain('/repo/innocent-looking-link');
  });

  it('approval-gates checks, candidate persistence, and GitHub publication', async () => {
    const agent = await fixture();
    for (const name of ['run_release_checks', 'save_release_candidate', 'publish_draft_release']) {
      expect(agent.tools?.[name]?.needsApproval, name).toBe(true);
    }
    expect(agent.tools?.inspect_release_state?.replay).toBe(false);
    expect(agent.tools?.get_release_candidate?.replay).toBe(false);
  });

  it('denies attempted writes through the repository workspace path', async () => {
    expect(await releasePolicy().decide({ toolName: 'workspace', args: { op: 'write', path: '/repo/package.json', content: '{}' } })).toEqual({
      kind: 'deny',
      reason: 'The repository mount is immutable. Write release artifacts under /output.',
    });
  });
});
