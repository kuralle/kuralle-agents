import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime, MemoryStore, type AgentConfig, type StreamPart } from '@kuralle-agents/core';
import {
  InMemoryDeploymentStore,
  NamedRegistry,
  VersionedRegistry,
  bindAgentVersion,
  type AgentVersion,
  type RuntimeBindings,
  type RuntimeRevision,
  type ThreadPin,
} from '@kuralle-agents/deployment';
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

  it('retains content-addressed source bytes for every non-inline artifact entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kuralle-agent-blobs-'));
    await mkdir(join(root, 'references'));
    await writeFile(join(root, 'instructions.md'), 'Use the packaged image.');
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(join(root, 'references', 'diagram.png'), image);

    const compiled = await compileAgentDirectory(root, { ...OPTIONS, target: 'node' });
    expect(compiled.blobs).toHaveLength(1);
    expect(compiled.blobs[0]).toMatchObject({
      digest: compiled.rootArtifact.references[0]?.digest,
      bytes: image.byteLength,
      mediaType: 'image/png',
    });
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

const REFUND_FLOW = JSON.stringify({
  name: 'refund',
  description: 'Start a refund.',
  start: 'say',
  nodes: [{
    kind: 'reply',
    id: 'say',
    response: { template: 'Refund started' },
    next: { end: 'done' },
  }],
}, null, 2);

describe('inline flow.json compilation', () => {
  it('embeds a valid flows/*.flow.json file and changes the digest when the file changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kuralle-inline-flow-'));
    await writeFile(join(directory, 'instructions.md'), 'You are concise.');
    await mkdir(join(directory, 'flows'));
    await writeFile(join(directory, 'flows', 'refund.flow.json'), REFUND_FLOW);

    const first = await compileAgentDirectory(directory, { ...OPTIONS, target: 'node' });
    expect(first.rootArtifact.flows).toEqual([{
      kind: 'inline',
      id: 'refund',
      definition: JSON.parse(REFUND_FLOW),
    }]);
    expect(first.modules.filter(module => module.kind === 'flow')).toEqual([]);

    await writeFile(
      join(directory, 'flows', 'refund.flow.json'),
      REFUND_FLOW.replace('Start a refund.', 'Start a refund, revised.'),
    );
    const second = await compileAgentDirectory(directory, { ...OPTIONS, target: 'node' });
    expect(first.rootArtifact.digest).not.toBe(second.rootArtifact.digest);
  });

  it('fails the build for an invalid flow file, naming the dotted issue path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kuralle-invalid-flow-'));
    await writeFile(join(directory, 'instructions.md'), 'You are concise.');
    await mkdir(join(directory, 'flows'));
    await writeFile(join(directory, 'flows', 'refund.flow.json'), JSON.stringify({
      name: 'refund',
      description: 'bad',
      start: 'missing',
      nodes: [{ kind: 'reply', id: 'greet', generate: true, next: { end: 'done' } }],
    }));

    const error = await compileAgentDirectory(directory, { ...OPTIONS, target: 'node' }).catch(value => value);
    expect(error).toBeInstanceOf(AgentBuildError);
    const diagnostic = (error as AgentBuildError).diagnostics.find(entry => entry.code === 'FLOW_INVALID');
    expect(diagnostic?.path).toBe('flows/refund.flow.json');
    expect(diagnostic?.message).toMatch(/\[missing-start\] start/);
  });

  it('keeps TypeScript flow modules as capability references alongside inline json', async () => {
    const compiled = await compileAgentDirectory(join(FIXTURES, 'support'), OPTIONS);
    expect(compiled.rootArtifact.flows).toEqual([{
      id: 'checkout',
      capability: 'test.support:flow:checkout',
      versionRange: '=1.0.0',
    }]);
  });

  it('binds the compiled artifact and executes the inline flow for one scripted turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kuralle-inline-bind-'));
    await writeFile(join(directory, 'instructions.md'), 'You are concise.');
    await mkdir(join(directory, 'flows'));
    await writeFile(join(directory, 'flows', 'refund.flow.json'), REFUND_FLOW);
    const compiled = await compileAgentDirectory(directory, { ...OPTIONS, target: 'node' });
    const artifact = compiled.rootArtifact;
    const createdAt = '2026-08-01T00:00:00.000Z';
    const pin: ThreadPin = {
      tenantId: 'tenant-a',
      threadId: 'thread-a',
      agentEntityId: artifact.agent.id,
      agentVersionId: 'version-1',
      artifactDigest: artifact.digest,
      runtimeRevisionId: 'runtime-1',
      releaseId: 'release-1',
      environment: 'production',
      configGeneration: 1,
      secretGeneration: 1,
      assignedAt: createdAt,
    };
    const agentVersion: AgentVersion = {
      id: 'version-1',
      tenantId: 'tenant-a',
      agentEntityId: artifact.agent.id,
      version: 1,
      artifact,
      createdBy: 'owner-1',
      createdAt,
    };
    const runtimeRevision: RuntimeRevision = {
      id: 'runtime-1',
      artifactSchemaVersions: [1],
      runtimeApiVersion: '1.2.0',
      capabilities: [],
      createdAt,
    };
    const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
    models.register(
      artifact.agent.model,
      { specificationVersion: 'v3', provider: 'test', modelId: 'test' } as NonNullable<AgentConfig['model']>,
    );
    const bindings: RuntimeBindings = {
      models,
      tools: new VersionedRegistry(),
      flows: new VersionedRegistry(),
    };
    const bound = await bindAgentVersion({
      version: agentVersion,
      pin,
      runtime: runtimeRevision,
      bindings,
    });
    const flow = bound.agent.flows?.[0];
    if (!flow) throw new Error('expected compiled inline flow to bind');
    expect(flow.name).toBe('refund');

    const parts: StreamPart[] = [];
    const handle = createRuntime({
      agents: [bound.agent],
      defaultAgentId: bound.agent.id,
      defaultModel: bound.agent.model,
      sessionStore: new MemoryStore(),
      hostSelect: async () => ({ kind: 'enterFlow' as const, flow }),
    }).run({
      sessionId: 'compiled-inline-flow',
      input: 'refund please',
      driver: {
        async runAgentTurn() {
          return { text: '', toolResults: [] };
        },
        async awaitUser() {
          return { type: 'message', input: '' };
        },
      },
    });
    for await (const part of handle.events) parts.push(part);
    await handle;

    expect(parts.some(part => part.type === 'flow-enter' && part.payload.flow === 'refund')).toBe(true);
    expect(parts.some(part => part.type === 'text-delta' && part.payload.delta === 'Refund started')).toBe(true);
    expect(parts.some(part => part.type === 'flow-end' && part.payload.flow === 'refund')).toBe(true);
    expect(basename(directory)).toBe(artifact.agent.id);
  });
});
