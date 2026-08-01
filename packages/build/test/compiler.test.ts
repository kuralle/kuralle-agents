import { describe, expect, it } from 'bun:test';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryDeploymentStore } from '@kuralle-agents/deployment';
import {
  AgentBuildError,
  compileAgentDirectory,
  generateCapabilityRegistrySource,
} from '../src/index.js';

const FIXTURES = join(import.meta.dir, 'fixtures');
const OPTIONS = {
  defaultModel: 'openai/gpt-5-mini',
  compilerVersion: '0.19.0',
  runtimeApiRange: '^1.0.0',
  target: 'cloudflare' as const,
  artifactIdPrefix: 'test',
};

describe('folder agent compiler', () => {
  it('compiles nested agents, complete skills, context, and static capability modules deterministically', async () => {
    const first = await compileAgentDirectory(join(FIXTURES, 'support'), OPTIONS);
    const second = await compileAgentDirectory(join(FIXTURES, 'support'), OPTIONS);

    expect(first.rootArtifact.digest).toBe(second.rootArtifact.digest);
    expect(first.artifacts).toHaveLength(2);
    expect(first.rootArtifact.agent).toMatchObject({
      id: 'support',
      name: 'Support',
      model: 'openai/gpt-5-mini',
      limits: { maxTurns: 12 },
    });
    const billing = first.artifacts.find(artifact => artifact.agent.id === 'billing');
    expect(billing).toBeDefined();
    expect(first.rootArtifact.agents).toEqual([{
      id: 'billing',
      artifactId: 'test.support.billing',
      digest: billing!.digest,
    }]);
    expect(first.rootArtifact.skills[0]?.files.map(file => file.path)).toEqual([
      'skills/returns/references/policy.md',
      'skills/returns/SKILL.md',
    ]);
    expect(first.rootArtifact.references.map(file => file.path)).toEqual(['references/faq.md']);
    expect(first.rootArtifact.workspaceSeed.map(file => file.path)).toEqual(['workspace/README.md']);
    expect(first.modules.map(module => `${module.kind}:${module.id}:${module.exportName}`)).toEqual([
      'flow:checkout:default',
      'policy:tool:tool',
      'policy:validate:validate',
      'tool:lookup_order:default',
    ]);
    const generated = generateCapabilityRegistrySource(first, {
      generatedFile: join(FIXTURES, 'support', '.kuralle', 'capabilities.ts'),
    });
    expect(generated).toContain('import capability0 from "../flows/checkout.ts";');
    expect(generated).toContain('export const runtimeCapabilities =');
    expect(generated).toContain('bindings.tools.register');
    expect(generated).toContain('bindings.toolPolicies.register');
  });

  it('publishes the same canonical artifact through a database builder draft', async () => {
    const compiled = await compileAgentDirectory(join(FIXTURES, 'support'), OPTIONS);
    const { digest: _digest, ...definition } = compiled.rootArtifact;
    const store = new InMemoryDeploymentStore();
    await store.createEntity({
      id: 'support',
      tenantId: 'tenant-a',
      slug: 'support',
      status: 'active',
      ownerId: 'owner-1',
      visibility: 'private',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const draft = await store.saveDraft({
      id: 'draft-1',
      tenantId: 'tenant-a',
      agentEntityId: 'support',
      revision: 0,
      definition,
      updatedBy: 'owner-1',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }, 0);

    const published = await store.publishDraft({
      tenantId: 'tenant-a',
      draftId: draft.id,
      draftRevision: draft.revision,
      versionId: 'version-1',
      version: 1,
      createdBy: 'owner-1',
      createdAt: '2026-08-01T00:00:01.000Z',
    });

    expect(published.artifact).toEqual(compiled.rootArtifact);
    expect(published.artifact.digest).toBe(compiled.rootArtifact.digest);
  });

  it('accumulates config, export, target, and unknown-slot diagnostics', async () => {
    const promise = compileAgentDirectory(join(FIXTURES, 'invalid-cloudflare'), OPTIONS);
    const error = await promise.catch(value => value);

    expect(error).toBeInstanceOf(AgentBuildError);
    expect((error as AgentBuildError).diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      'AGENT_CONFIG_INVALID',
      'UNKNOWN_SLOT',
      'MODULE_EXPORT_INVALID',
      'MODULE_EXPORT_INVALID',
      'TARGET_INCOMPATIBLE',
    ]);
  });

  it('rejects symlinks instead of following content outside the source tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kuralle-build-'));
    await writeFile(join(directory, 'instructions.md'), 'Safe instructions.');
    await symlink('/etc/passwd', join(directory, 'agent.json'));

    const error = await compileAgentDirectory(directory, OPTIONS).catch(value => value);
    expect(error).toBeInstanceOf(AgentBuildError);
    expect((error as AgentBuildError).diagnostics).toContainEqual(expect.objectContaining({
      code: 'SYMLINK_REJECTED',
      path: 'agent.json',
    }));
  });

  it('enforces deterministic file quotas before packaging oversized context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kuralle-build-'));
    await writeFile(join(directory, 'instructions.md'), 'This is too large.');

    const error = await compileAgentDirectory(directory, {
      ...OPTIONS,
      quotas: { maxFileBytes: 4 },
    }).catch(value => value);
    expect(error).toBeInstanceOf(AgentBuildError);
    expect((error as AgentBuildError).diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'FILE_QUOTA_EXCEEDED',
    );
  });
});
