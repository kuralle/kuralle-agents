import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReleaseService } from '../src/release-service.js';
import { runProcess } from '../src/process.js';
import type { ReleaseAgentConfig } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(checkExitCode = 0): Promise<{ config: ReleaseAgentConfig; service: ReleaseService }> {
  const base = await mkdtemp(join(tmpdir(), 'kuralle-release-governance-'));
  roots.push(base);
  const root = join(base, 'repo');
  await mkdir(root);
  for (const command of [
    ['git', 'init', '-b', 'main'],
    ['git', 'config', 'user.name', 'Release Test'],
    ['git', 'config', 'user.email', 'release@example.test'],
  ] as [string, ...string[]][]) {
    const result = await runProcess(command, { cwd: root });
    expect(result.exitCode).toBe(0);
  }
  await writeFile(join(root, 'README.md'), '# Fixture\n');
  await runProcess(['git', 'add', 'README.md'], { cwd: root });
  await runProcess(['git', 'commit', '-m', 'feat: initial release fixture'], { cwd: root });
  const config: ReleaseAgentConfig = {
    repoRoot: root,
    stateRoot: join(base, 'release-state'),
    repository: 'acme/widgets',
    releaseBranch: 'main',
    checks: [{ name: 'fixture check', command: [process.execPath, '-e', `process.exit(${checkExitCode})`] }],
  };
  return { config, service: new ReleaseService(config) };
}

describe('ReleaseService', () => {
  it('binds passing check evidence and a candidate revision to one clean HEAD', async () => {
    const { service } = await fixture();
    const snapshot = await service.inspect();
    expect(snapshot.clean).toBe(true);
    expect(snapshot.branch).toBe('main');
    const checks = await service.runChecks();
    expect(checks.passed).toBe(true);
    expect(checks.headSha).toBe(snapshot.headSha);
    const candidate = await service.saveCandidate({
      expectedHeadSha: snapshot.headSha,
      tagName: 'v1.2.3',
      title: 'Widgets 1.2.3',
      body: '## Added\n\n- A release candidate grounded in the committed fixture and passing checks.',
    });
    expect(candidate.revision).toHaveLength(64);
    expect((await service.validateCandidate(candidate.revision)).headSha).toBe(snapshot.headSha);
  });

  it('fails closed when checks fail', async () => {
    const { service } = await fixture(7);
    const snapshot = await service.inspect();
    expect((await service.runChecks()).passed).toBe(false);
    await expect(service.saveCandidate({
      expectedHeadSha: snapshot.headSha,
      tagName: 'v1.2.3',
      title: 'Widgets 1.2.3',
      body: '## Fixed\n\n- This body is long enough, but failed evidence must block candidate creation.',
    })).rejects.toThrow(/No passing release check run/);
  });

  it('refuses release checks from a dirty worktree or the wrong branch', async () => {
    const dirty = await fixture();
    await writeFile(join(dirty.config.repoRoot, 'UNCOMMITTED.md'), '# Not reviewed\n');
    await expect(dirty.service.runChecks()).rejects.toThrow(/Repository is dirty: UNCOMMITTED\.md/);

    const wrongBranch = await fixture();
    const switched = await runProcess(['git', 'switch', '-c', 'feature/not-a-release'], {
      cwd: wrongBranch.config.repoRoot,
    });
    expect(switched.exitCode).toBe(0);
    await expect(wrongBranch.service.runChecks()).rejects.toThrow(
      /Release operations require branch main; current branch is feature\/not-a-release/,
    );
  });

  it('rejects a candidate after the repository moves', async () => {
    const { config, service } = await fixture();
    const snapshot = await service.inspect();
    await service.runChecks();
    const candidate = await service.saveCandidate({
      expectedHeadSha: snapshot.headSha,
      tagName: 'v1.2.3',
      title: 'Widgets 1.2.3',
      body: '## Changed\n\n- This release is intentionally invalidated by a later repository commit.',
    });
    await writeFile(join(config.repoRoot, 'CHANGELOG.md'), '# Changed\n');
    await runProcess(['git', 'add', 'CHANGELOG.md'], { cwd: config.repoRoot });
    await runProcess(['git', 'commit', '-m', 'docs: move release head'], { cwd: config.repoRoot });
    await expect(service.validateCandidate(candidate.revision)).rejects.toThrow(/ESTALE/);
  });
});
