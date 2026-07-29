import { defineAgent, defineTool, needsApprovalPolicy, type Policy } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { publishGitHubDraft } from './github.js';
import { ReleaseService } from './release-service.js';
import type { ReleaseAgentConfig } from './types.js';
import { createReleaseSkillStore, createReleaseWorkspace, WORKSPACE_INSTRUCTIONS } from './workspace.js';

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const headSha = z.string().regex(/^[a-f0-9]{40,64}$/);

export function releasePolicy(): Policy {
  return {
    decide: (request) => {
      if (request.toolName === 'workspace' && typeof request.args === 'object' && request.args) {
        const args = request.args as { op?: string; path?: string };
        if ((args.op === 'write' || args.op === 'edit') && args.path?.startsWith('/repo')) {
          return { kind: 'deny', reason: 'The repository mount is immutable. Write release artifacts under /output.' };
        }
      }
      if (request.toolName === 'publish_draft_release') {
        return { kind: 'ask', title: 'Publish this exact candidate as a GitHub draft release' };
      }
      return needsApprovalPolicy.decide(request);
    },
  };
}

export function buildReleaseGovernanceAgent(options: {
  model: LanguageModel;
  config: ReleaseAgentConfig;
  skillRoot: string;
  githubToken?: string;
}) {
  const service = new ReleaseService(options.config);
  const inspectReleaseState = defineTool({
    name: 'inspect_release_state',
    description: 'Capture the authoritative current branch, HEAD, cleanliness, commits, changed paths, changesets, and latest tag. Always call before release work.',
    input: z.object({}),
    replay: false,
    execute: async () => service.inspect(),
  });
  const runReleaseChecks = defineTool({
    name: 'run_release_checks',
    description: 'Run the configured production release gates against the current clean release-branch commit and persist the check evidence bound to that HEAD.',
    input: z.object({}),
    needsApproval: true,
    replay: false,
    timeoutMs: 60 * 60_000,
    execute: async () => service.runChecks(),
  });
  const saveReleaseCandidate = defineTool({
    name: 'save_release_candidate',
    description: 'Save revisioned release notes for a clean, checked HEAD. Fails if HEAD moved, checks did not pass, the tag exists, or the body is too small.',
    input: z.object({
      expectedHeadSha: headSha,
      tagName: z.string().min(5).max(80),
      title: z.string().min(4).max(160),
      body: z.string().min(40).max(50_000),
    }),
    needsApproval: true,
    execute: async (input) => service.saveCandidate(input),
  });
  const getReleaseCandidate = defineTool({
    name: 'get_release_candidate',
    description: 'Read the exact saved release candidate and its revision before asking to publish.',
    input: z.object({}),
    replay: false,
    execute: async () => ({ candidate: await service.getCandidate() ?? null }),
  });
  const publishDraftRelease = defineTool({
    name: 'publish_draft_release',
    description: 'After human approval, revalidate the candidate, checks, branch, cleanliness, and HEAD, then create an idempotent draft-only GitHub release in the configured repository.',
    input: z.object({ candidateRevision: revision }),
    needsApproval: true,
    idempotencyKey: ({ candidateRevision }) => `${options.config.repository}:${candidateRevision}`,
    execute: async ({ candidateRevision }) => {
      const token = options.githubToken?.trim();
      if (!token) throw new Error('GITHUB_TOKEN is required only when publishing a GitHub draft release.');
      const candidate = await service.validateCandidate(candidateRevision);
      return publishGitHubDraft(candidate, { token });
    },
  });

  return defineAgent({
    id: 'release-governance',
    name: 'Release Governance Agent',
    description: 'Audits a real repository, runs release gates, drafts evidence-grounded notes, and publishes an approval-gated GitHub draft release.',
    model: options.model,
    instructions: `You are the release governor for exactly ${options.config.repository}. Your job is to produce a reviewable, evidence-grounded GitHub draft release without modifying source code, tags, branches, or published releases.

Start every task with inspect_release_state. If the repository is dirty, on the wrong branch, or HEAD changes, stop and report the exact blocker. Load the release-governance skill before drafting notes. Ground every claim in commits, changesets, tests, or files under /repo; never infer a feature from a filename alone.

The required order is inspect → run_release_checks → inspect relevant evidence → draft → save_release_candidate → get_release_candidate → ask the operator to review the exact revision → publish_draft_release. Never skip a gate, create a tag, push a branch, publish a non-draft release, edit the repository, or expose credentials. Use /output only for working artifacts.`,
    workspace: {
      fs: createReleaseWorkspace(options.config),
      readOnly: false,
      modelWritable: true,
      instructions: WORKSPACE_INSTRUCTIONS,
    },
    skills: createReleaseSkillStore(options.skillRoot),
    tools: {
      inspect_release_state: inspectReleaseState,
      run_release_checks: runReleaseChecks,
      save_release_candidate: saveReleaseCandidate,
      get_release_candidate: getReleaseCandidate,
      publish_draft_release: publishDraftRelease,
    },
    policy: releasePolicy(),
    limits: { maxSteps: 24, toolMaxSteps: 18 },
  });
}
