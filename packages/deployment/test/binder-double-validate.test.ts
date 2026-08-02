import { describe, expect, it, mock } from 'bun:test';
import { defineTool, type AgentConfig } from '@kuralle-agents/core';
import type { AgentArtifact, AgentVersion, RuntimeBindings, RuntimeRevision, ThreadPin } from '../src/index.js';
import { artifactInput } from './fixtures.js';

const CREATED_AT = '2026-08-01T00:00:00.000Z';

function runtime(): RuntimeRevision {
  return {
    id: 'runtime-1',
    artifactSchemaVersions: [1],
    runtimeApiVersion: '1.2.0',
    capabilities: [],
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

// `NamedRegistry`/`VersionedRegistry` come from `../src/index.js`, which the first test must
// import dynamically (after `mock.module`) rather than statically at the top of this file — a
// static top-level import would resolve `../src/canonical.js` before the mock is installed.
function bindings(kuralleDeployment: typeof import('../src/index.js')): RuntimeBindings {
  const { NamedRegistry, VersionedRegistry } = kuralleDeployment;
  const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
  models.register(
    'openai/gpt-5-mini',
    { specificationVersion: 'v3', provider: 'test', modelId: 'test' } as NonNullable<AgentConfig['model']>,
  );
  return {
    models,
    tools: new VersionedRegistry<ReturnType<typeof defineTool>>(),
    flows: new VersionedRegistry(),
  };
}

describe('bindAgentVersion validates the root artifact exactly once', () => {
  it('hashes the root artifact exactly once per bind (not once per validate call)', async () => {
    // Mock the low-level hash primitive before dynamically importing anything that depends on
    // it, so both `bindAgentVersion` and this test observe the same counting wrapper.
    const realCanonical = await import('../src/canonical.js');
    // Snapshot the real implementation into a plain variable before installing the mock —
    // `realCanonical.sha256` is a live ES module binding, so reading it *inside* the wrapper
    // below (instead of here) would resolve to the wrapper itself once the mock is active,
    // recursing forever.
    const originalSha256 = realCanonical.sha256;
    let calls = 0;
    mock.module('../src/canonical.js', () => ({
      ...realCanonical,
      sha256: async (value: string | Uint8Array) => {
        calls += 1;
        return originalSha256(value);
      },
    }));

    const kuralleDeployment = await import('../src/index.js');
    const { bindAgentVersion, createArtifact } = kuralleDeployment;
    const artifact = await createArtifact(artifactInput());

    calls = 0; // discard the hashing done by createArtifact's own fixture construction
    await bindAgentVersion({
      version: version(artifact),
      pin: pin(artifact),
      runtime: runtime(),
      bindings: bindings(kuralleDeployment),
    });

    // The fixture artifact has exactly one inline content entry (the instructions file) and no
    // skills, so a single `validateArtifact` pass hashes it exactly twice (once for the inline
    // content digest, once for the overall canonical artifact digest), plus one more hash when
    // the bound instructions are read back off the (separately re-verified) content entry — 3
    // total. A bind that (redundantly) validated the root twice would hash it 5 times.
    expect(calls).toBe(3);
  });
});

describe('bindAgentVersion validates subagent artifacts', () => {
  it('rejects a subagent artifact whose digest does not match its content', async () => {
    const kuralleDeployment = await import('../src/index.js');
    const { bindAgentVersion, createArtifact } = kuralleDeployment;

    const subagentArtifact = await createArtifact(artifactInput({
      artifactId: 'billing-artifact',
      agent: {
        id: 'billing',
        name: 'Billing',
        model: 'openai/gpt-5-mini',
        limits: { maxTurns: 12, maxSteps: 20 },
        handoffs: [],
      },
    }));
    // Simulate a compromised or corrupted external resolver: the content changed but the
    // artifact still claims its original (now stale) digest.
    const tamperedSubagent: AgentArtifact = {
      ...subagentArtifact,
      agent: { ...subagentArtifact.agent, name: 'Tampered Billing' },
    };

    const rootArtifact = await createArtifact(artifactInput({
      agents: [{
        id: 'billing',
        artifactId: subagentArtifact.artifactId,
        digest: subagentArtifact.digest,
      }],
    }));

    const runtimeBindings = bindings(kuralleDeployment);
    runtimeBindings.artifacts = { get: async () => tamperedSubagent };

    await expect(bindAgentVersion({
      version: version(rootArtifact),
      pin: pin(rootArtifact),
      runtime: runtime(),
      bindings: runtimeBindings,
    })).rejects.toThrow(/digest/i);
  });
});
