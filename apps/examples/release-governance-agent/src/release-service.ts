import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReleaseAgentConfig, ReleaseCandidate, ReleaseCheckRun, ReleaseSnapshot } from './types.js';
import { git, runProcess } from './process.js';

const tagPattern = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const checkPath = (config: ReleaseAgentConfig, headSha: string): string => join(config.stateRoot, `checks-${headSha}.json`);
const candidatePath = (config: ReleaseAgentConfig): string => join(config.stateRoot, 'candidate.json');
const parseLines = (value: string): string[] => value ? value.split('\n').map((line) => line.trim()).filter(Boolean) : [];

export class ReleaseService {
  constructor(readonly config: ReleaseAgentConfig) {}

  async inspect(): Promise<ReleaseSnapshot> {
    const topLevel = await git(this.config.repoRoot, 'rev-parse', '--show-toplevel');
    const [expected, actual] = await Promise.all([realpath(this.config.repoRoot), realpath(topLevel)]);
    if (actual !== expected) throw new Error(`Configured repository root ${expected} resolves to ${actual}.`);

    const branch = await git(this.config.repoRoot, 'branch', '--show-current');
    const headSha = await git(this.config.repoRoot, 'rev-parse', 'HEAD');
    const dirtyPaths = parseLines(await git(this.config.repoRoot, 'status', '--porcelain=v1'))
      .map((line) => line.slice(3).trim());
    let latestTag: string | undefined;
    try { latestTag = await git(this.config.repoRoot, 'describe', '--tags', '--abbrev=0'); }
    catch { latestTag = undefined; }
    const range = latestTag ? `${latestTag}..HEAD` : 'HEAD';
    const commitRows = parseLines(await git(
      this.config.repoRoot,
      'log',
      '--max-count=200',
      '--format=%H%x09%s%x09%an',
      range,
    ));
    const changedPaths = latestTag
      ? parseLines(await git(this.config.repoRoot, 'diff', '--name-only', `${latestTag}..HEAD`))
      : parseLines(await git(this.config.repoRoot, 'ls-tree', '-r', '--name-only', 'HEAD'));
    const changesets = parseLines(await git(this.config.repoRoot, 'ls-files', '.changeset/*.md'))
      .filter((path) => !path.endsWith('README.md'));
    return {
      repository: this.config.repository,
      repoRoot: this.config.repoRoot,
      branch,
      headSha,
      clean: dirtyPaths.length === 0,
      dirtyPaths,
      ...(latestTag ? { latestTag } : {}),
      commits: commitRows.map((row) => {
        const [sha = '', subject = '', author = ''] = row.split('\t');
        return { sha, subject, author };
      }),
      changedPaths,
      changesets,
      capturedAt: new Date().toISOString(),
    };
  }

  async runChecks(): Promise<ReleaseCheckRun> {
    const snapshot = await this.assertReleasableSnapshot();
    const startedAt = new Date().toISOString();
    const results = [];
    for (const check of this.config.checks) {
      const result = await runProcess(check.command, { cwd: this.config.repoRoot });
      results.push({ name: check.name, command: [...check.command], ...result });
      if (result.exitCode !== 0) break;
    }
    const run: ReleaseCheckRun = {
      headSha: snapshot.headSha,
      passed: results.length === this.config.checks.length && results.every((result) => result.exitCode === 0),
      startedAt,
      completedAt: new Date().toISOString(),
      results,
    };
    await mkdir(this.config.stateRoot, { recursive: true });
    await writeFile(checkPath(this.config, snapshot.headSha), `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' })
      .catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        await writeFile(checkPath(this.config, snapshot.headSha), `${JSON.stringify(run, null, 2)}\n`);
      });
    return run;
  }

  async getCheckRun(headSha: string): Promise<ReleaseCheckRun | undefined> {
    try { return JSON.parse(await readFile(checkPath(this.config, headSha), 'utf8')) as ReleaseCheckRun; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async saveCandidate(input: { expectedHeadSha: string; tagName: string; title: string; body: string }): Promise<ReleaseCandidate> {
    const snapshot = await this.assertReleasableSnapshot();
    if (snapshot.headSha !== input.expectedHeadSha) {
      throw new Error(`ESTALE: expected ${input.expectedHeadSha}, current HEAD is ${snapshot.headSha}.`);
    }
    if (!tagPattern.test(input.tagName)) throw new Error('Tag must be a semantic version such as v1.2.3.');
    if (input.title.trim().length < 4 || input.title.length > 160) throw new Error('Release title must be 4-160 characters.');
    if (input.body.trim().length < 40 || input.body.length > 50_000) throw new Error('Release body must be 40-50000 characters.');
    try {
      await git(this.config.repoRoot, 'rev-parse', '--verify', `refs/tags/${input.tagName}`);
      throw new Error(`Tag ${input.tagName} already exists locally.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Tag ')) throw error;
    }
    const checkRun = await this.getCheckRun(snapshot.headSha);
    if (!checkRun?.passed) throw new Error(`No passing release check run is recorded for ${snapshot.headSha}.`);
    const base = {
      schemaVersion: 1 as const,
      repository: this.config.repository,
      branch: snapshot.branch,
      headSha: snapshot.headSha,
      tagName: input.tagName,
      title: input.title.trim(),
      body: input.body.trim(),
      checkRunCompletedAt: checkRun.completedAt,
      createdAt: new Date().toISOString(),
    };
    const candidate: ReleaseCandidate = { ...base, revision: sha256(JSON.stringify(base)) };
    await mkdir(this.config.stateRoot, { recursive: true });
    await writeFile(candidatePath(this.config), `${JSON.stringify(candidate, null, 2)}\n`);
    await writeFile(join(this.config.stateRoot, `${candidate.tagName}.md`), `${candidate.body}\n`);
    return candidate;
  }

  async getCandidate(): Promise<ReleaseCandidate | undefined> {
    try { return JSON.parse(await readFile(candidatePath(this.config), 'utf8')) as ReleaseCandidate; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async validateCandidate(revision: string): Promise<ReleaseCandidate> {
    const candidate = await this.getCandidate();
    if (!candidate) throw new Error('No release candidate has been saved.');
    if (candidate.revision !== revision) throw new Error('ESTALE: release candidate revision changed.');
    const snapshot = await this.assertReleasableSnapshot();
    if (snapshot.headSha !== candidate.headSha || snapshot.branch !== candidate.branch) {
      throw new Error('ESTALE: repository HEAD or branch changed after candidate creation.');
    }
    const checkRun = await this.getCheckRun(candidate.headSha);
    if (!checkRun?.passed || checkRun.completedAt !== candidate.checkRunCompletedAt) {
      throw new Error('The check run bound to this candidate is missing or no longer matches.');
    }
    return candidate;
  }

  private async assertReleasableSnapshot(): Promise<ReleaseSnapshot> {
    const snapshot = await this.inspect();
    if (!snapshot.clean) throw new Error(`Repository is dirty: ${snapshot.dirtyPaths.join(', ')}`);
    if (snapshot.branch !== this.config.releaseBranch) {
      throw new Error(`Release operations require branch ${this.config.releaseBranch}; current branch is ${snapshot.branch || '(detached)'}.`);
    }
    return snapshot;
  }
}
