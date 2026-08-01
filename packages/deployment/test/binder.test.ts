import { describe, expect, it } from 'bun:test';
import {
  defineTool,
  type AgentConfig,
  type Flow,
} from '@kuralle-agents/core';
import type { SkillStoreLike } from '@kuralle-agents/core/types';
import {
  NamedRegistry,
  VersionedRegistry,
  bindAgentVersion,
  createArtifact,
  preflightArtifact,
  sha256,
  skillPackageDigest,
} from '../src/index.js';
import type {
  AgentArtifact,
  AgentVersion,
  RuntimeBindings,
  RuntimeRevision,
  SkillArtifact,
  ThreadPin,
} from '../src/index.js';
import { artifactInput } from './fixtures.js';

const CREATED_AT = '2026-08-01T00:00:00.000Z';

function runtime(capabilities: Array<{ id: string; version: string }>): RuntimeRevision {
  return {
    id: 'runtime-1',
    artifactSchemaVersions: [1],
    runtimeApiVersion: '1.2.0',
    capabilities,
    createdAt: CREATED_AT,
  };
}

function pin(artifact: AgentArtifact): ThreadPin {
  return {
    tenantId: 'tenant-a',
    threadId: 'thread-a',
    agentEntityId: 'support',
    agentVersionId: 'version-1',
    artifactDigest: artifact.digest,
    runtimeRevisionId: 'runtime-1',
    releaseId: 'release-1',
    branch: 'main',
    environment: 'production',
    configGeneration: 2,
    secretGeneration: 3,
    assignedAt: CREATED_AT,
  };
}

function version(artifact: AgentArtifact): AgentVersion {
  return {
    id: 'version-1',
    tenantId: 'tenant-a',
    agentEntityId: 'support',
    version: 1,
    artifact,
    createdBy: 'owner-1',
    createdAt: CREATED_AT,
  };
}

function bindings(): RuntimeBindings {
  const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
  models.register(
    'openai/gpt-5-mini',
    { specificationVersion: 'v3', provider: 'test', modelId: 'test' } as NonNullable<AgentConfig['model']>,
  );
  const tools = new VersionedRegistry<ReturnType<typeof defineTool>>();
  tools.register({
    id: 'orders.lookup',
    version: '1.1.0',
    value: defineTool({
      name: 'lookup_order',
      description: 'Look up one order.',
      execute: async () => ({ status: 'ok' }),
    }),
  });
  const start = { kind: 'reply' as const, id: 'start', instructions: 'Help with checkout.' };
  const checkout: Flow = {
    name: 'checkout',
    description: 'Checkout flow',
    start,
    nodes: [start],
  };
  const flows = new VersionedRegistry<Flow>();
  flows.register({ id: 'flows.checkout', version: '2.0.0', value: checkout });
  return { models, tools, flows };
}

describe('runtime compatibility and artifact binding', () => {
  it('checks runtime API and exact capability version ranges before traffic', async () => {
    const artifact = await createArtifact(artifactInput({
      requiredCapabilities: [{ capability: 'orders.lookup', versionRange: '^2.0.0' }],
    }));
    const report = preflightArtifact(artifact, runtime([{ id: 'orders.lookup', version: '1.4.0' }]));

    expect(report.compatible).toBe(false);
    expect(report.diagnostics).toContainEqual({
      code: 'CAPABILITY_VERSION_UNSUPPORTED',
      capability: 'orders.lookup',
      message: 'orders.lookup@1.4.0 does not satisfy ^2.0.0',
    });
  });

  it('binds trusted tools and flows and returns closed deployment trace identity', async () => {
    const artifact = await createArtifact(artifactInput({
      tools: [{
        kind: 'trusted',
        id: 'lookup_order',
        capability: 'orders.lookup',
        versionRange: '^1.0.0',
      }],
      flows: [{ id: 'checkout', capability: 'flows.checkout', versionRange: '^2.0.0' }],
      requiredCapabilities: [
        { capability: 'orders.lookup', versionRange: '^1.0.0' },
        { capability: 'flows.checkout', versionRange: '^2.0.0' },
      ],
    }));
    const deployedRuntime = runtime([
      { id: 'orders.lookup', version: '1.1.0' },
      { id: 'flows.checkout', version: '2.0.0' },
    ]);

    const bound = await bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: deployedRuntime,
      bindings: bindings(),
    });

    expect(bound.agent.instructions).toBe('You are concise.\n\n');
    expect(Object.keys(bound.agent.tools ?? {})).toEqual(['lookup_order']);
    expect(bound.agent.flows?.map(flow => flow.name)).toEqual(['checkout']);
    expect(bound.deployment).toEqual({
      tenantId: 'tenant-a',
      agentEntityId: 'support',
      agentVersionId: 'version-1',
      artifactDigest: artifact.digest,
      releaseId: 'release-1',
      runtimeRevisionId: 'runtime-1',
      environment: 'production',
      branch: 'main',
      configGeneration: 2,
      secretGeneration: 3,
    });
  });

  it('keeps skill bodies and resources I/O-progressive while verifying loaded bytes', async () => {
    const skillText = '---\nname: returns\ndescription: Handle returns.\n---\nFollow the returns policy.';
    const skillBytes = new TextEncoder().encode(skillText).byteLength;
    const skillWithoutDigest = {
      name: 'returns',
      description: 'Handle returns.',
      entrypoint: 'skills/returns/SKILL.md',
      files: [{
        path: 'skills/returns/SKILL.md',
        digest: await sha256(skillText),
        bytes: skillBytes,
        mediaType: 'text/markdown',
        role: 'skill',
        content: { kind: 'blob', ref: 'blob://returns-skill' },
      }],
    } satisfies Omit<SkillArtifact, 'digest'>;
    const skillDigest = await skillPackageDigest(skillWithoutDigest);
    const artifact = await createArtifact(artifactInput({
      skills: [{ ...skillWithoutDigest, digest: skillDigest }],
    }));
    let reads = 0;
    const runtimeBindings = bindings();
    runtimeBindings.content = {
      read: async () => {
        reads += 1;
        return skillText;
      },
    };
    const bound = await bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: runtime([]),
      bindings: runtimeBindings,
    });
    const skills = bound.agent.skills as SkillStoreLike;

    expect(await skills.list()).toEqual([{
      name: 'returns',
      description: 'Handle returns.',
      path: 'skills/returns/SKILL.md',
      contentHash: skillDigest,
    }]);
    expect(reads).toBe(0);
    expect(await skills.loadBody('returns')).toBe('Follow the returns policy.');
    expect(reads).toBe(1);
  });

  it('provisions verified workspace content per pinned thread and fails closed without a provider', async () => {
    const seedText = 'thread notes';
    const seed = {
      path: 'workspace/notes.md',
      digest: await sha256(seedText),
      bytes: new TextEncoder().encode(seedText).byteLength,
      mediaType: 'text/markdown',
      role: 'workspace-seed' as const,
      content: { kind: 'inline' as const, text: seedText },
    };
    const artifact = await createArtifact(artifactInput({ workspaceSeed: [seed] }));

    await expect(bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: runtime([]),
      bindings: bindings(),
    })).rejects.toThrow('no workspace provider is configured');

    const opened: Array<{ tenantId: string; threadId: string; bytes: string }> = [];
    const runtimeBindings = bindings();
    runtimeBindings.workspace = {
      open: async context => {
        opened.push({
          tenantId: context.pin.tenantId,
          threadId: context.pin.threadId,
          bytes: new TextDecoder().decode(await context.read(context.workspaceSeed[0])),
        });
        return { fs: {} as never, readOnly: false, modelWritable: true };
      },
    };
    const bound = await bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: runtime([]),
      bindings: runtimeBindings,
    });
    expect(typeof bound.agent.workspace).toBe('function');
    await (bound.agent.workspace as Function)({
      session: { id: 'runtime-session' },
      agentId: 'support',
    });
    expect(opened).toEqual([{
      tenantId: 'tenant-a',
      threadId: 'thread-a',
      bytes: seedText,
    }]);
  });
});

describe('capability resolution', () => {
  it('produces a config with no guardrails key when the artifact declares no policies', async () => {
    const artifact = await createArtifact(artifactInput());
    const bound = await bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: runtime([]),
      bindings: bindings(),
    });

    expect('guardrails' in bound.agent).toBe(false);
  });

  it('fails closed with the exact message when the input policy registry is missing', async () => {
    const artifact = await createArtifact(artifactInput({
      policies: { input: { id: 'policies.input', capability: 'policies.input', versionRange: '^1.0.0' } },
    }));

    await expect(bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: runtime([{ id: 'policies.input', version: '1.0.0' }]),
      bindings: bindings(),
    })).rejects.toThrow('no input policy registry is configured');
  });

  it('fails closed with the exact message when the output policy registry is missing', async () => {
    const artifact = await createArtifact(artifactInput({
      policies: { output: { id: 'policies.output', capability: 'policies.output', versionRange: '^1.0.0' } },
    }));

    await expect(bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: runtime([{ id: 'policies.output', version: '1.0.0' }]),
      bindings: bindings(),
    })).rejects.toThrow('no output policy registry is configured');
  });

  it('fails closed with the exact message when the tool policy registry is missing', async () => {
    const artifact = await createArtifact(artifactInput({
      policies: { tool: { id: 'policies.tool', capability: 'policies.tool', versionRange: '^1.0.0' } },
    }));

    await expect(bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: runtime([{ id: 'policies.tool', version: '1.0.0' }]),
      bindings: bindings(),
    })).rejects.toThrow('no tool policy registry is configured');
  });

  it('fails closed with the exact message when the refinement registry is missing', async () => {
    const artifact = await createArtifact(artifactInput({
      policies: { refine: { id: 'policies.refine', capability: 'policies.refine', versionRange: '^1.0.0' } },
    }));

    await expect(bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: runtime([{ id: 'policies.refine', version: '1.0.0' }]),
      bindings: bindings(),
    })).rejects.toThrow('no refinement registry is configured');
  });

  it('fails closed with the exact message when the validation registry is missing', async () => {
    const artifact = await createArtifact(artifactInput({
      policies: { validate: { id: 'policies.validate', capability: 'policies.validate', versionRange: '^1.0.0' } },
    }));

    await expect(bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: runtime([{ id: 'policies.validate', version: '1.0.0' }]),
      bindings: bindings(),
    })).rejects.toThrow('no validation registry is configured');
  });
});
