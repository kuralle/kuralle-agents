export interface ReleaseCheckDefinition {
  name: string;
  command: [string, ...string[]];
}

export interface ReleaseAgentConfig {
  repoRoot: string;
  stateRoot: string;
  repository: string;
  releaseBranch: string;
  checks: ReleaseCheckDefinition[];
}

export interface CommitSummary {
  sha: string;
  subject: string;
  author: string;
}

export interface ReleaseSnapshot {
  repository: string;
  repoRoot: string;
  branch: string;
  headSha: string;
  clean: boolean;
  dirtyPaths: string[];
  latestTag?: string;
  commits: CommitSummary[];
  changedPaths: string[];
  changesets: string[];
  capturedAt: string;
}

export interface ReleaseCheckResult {
  name: string;
  command: string[];
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface ReleaseCheckRun {
  headSha: string;
  passed: boolean;
  startedAt: string;
  completedAt: string;
  results: ReleaseCheckResult[];
}

export interface ReleaseCandidate {
  schemaVersion: 1;
  repository: string;
  branch: string;
  headSha: string;
  tagName: string;
  title: string;
  body: string;
  checkRunCompletedAt: string;
  createdAt: string;
  revision: string;
}

export interface PublishedDraftRelease {
  id: number;
  htmlUrl: string;
  tagName: string;
  draft: true;
  reused: boolean;
}
