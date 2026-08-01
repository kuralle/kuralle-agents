import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AgentConfig,
  AgentWorkspaceDefinition,
  AgentWorkspaceResolver,
  Session,
} from '@kuralle-agents/core';
import {
  NamedRegistry,
  VersionedRegistry,
  bindAgentVersion,
  createArtifact,
  sha256,
  type AgentArtifact,
  type AgentVersion,
  type RuntimeBindings,
  type RuntimeRevision,
  type ThreadPin,
} from '../src/index.js';
import { nodeArtifactWorkspaceProvider } from '../src/node-workspace.js';
import { artifactInput } from './fixtures.js';

const CREATED_AT = '2026-08-01T00:00:00.000Z';

function pin(artifact: AgentArtifact, threadId: string): ThreadPin {
  return {
    tenantId: 'tenant-a', threadId, agentEntityId: 'support', agentVersionId: 'version-1',
    artifactDigest: artifact.digest, runtimeRevisionId: 'runtime-1', releaseId: 'release-1',
    branch: 'main', environment: 'production', configGeneration: 1, secretGeneration: 1,
    assignedAt: CREATED_AT,
  };
}

function session(threadId: string): Session {
  const now = new Date();
  return {
    id: threadId, conversationId: threadId, channelId: 'api', createdAt: now, updatedAt: now,
    messages: [], workingMemory: {}, currentAgent: 'support', agentStates: {}, handoffHistory: [],
  };
}

describe('Node artifact workspaces', () => {
  it('mounts verified references read-only and preserves isolated thread mutations', async () => {
    const referenceText = 'Returns require a receipt.';
    const seedText = 'Initial notes';
    const artifact = await createArtifact(artifactInput({
      references: [{
        path: 'references/returns.md', digest: await sha256(referenceText),
        bytes: new TextEncoder().encode(referenceText).byteLength, mediaType: 'text/markdown',
        role: 'reference', content: { kind: 'inline', text: referenceText },
      }],
      workspaceSeed: [{
        path: 'workspace/notes.md', digest: await sha256(seedText),
        bytes: new TextEncoder().encode(seedText).byteLength, mediaType: 'text/markdown',
        role: 'workspace-seed', content: { kind: 'inline', text: seedText },
      }],
    }));
    const root = await mkdtemp(join(tmpdir(), 'kuralle-workspaces-'));
    const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
    models.register('openai/gpt-5-mini', { specificationVersion: 'v3', provider: 'test', modelId: 'test' } as never);
    const bindings: RuntimeBindings = {
      models,
      tools: new VersionedRegistry(),
      flows: new VersionedRegistry(),
      workspace: nodeArtifactWorkspaceProvider({ root, modelWritable: true }),
    };
    const runtime: RuntimeRevision = {
      id: 'runtime-1', artifactSchemaVersions: [1], runtimeApiVersion: '1.2.0',
      capabilities: [], createdAt: CREATED_AT,
    };
    const version: AgentVersion = {
      id: 'version-1', tenantId: 'tenant-a', agentEntityId: 'support', version: 1,
      artifact, createdBy: 'owner', createdAt: CREATED_AT,
    };

    const first = await bindAgentVersion({ version, pin: pin(artifact, 'thread-a'), runtime, bindings });
    const firstWorkspace = await (first.agent.workspace as AgentWorkspaceResolver)({
      session: session('thread-a'), agentId: 'support',
    }) as AgentWorkspaceDefinition & { fs: NonNullable<Extract<AgentWorkspaceDefinition, { fs: unknown }>['fs']> };
    expect(await firstWorkspace.fs.readFile('/references/returns.md')).toBe(referenceText);
    await expect(firstWorkspace.fs.writeFile('/references/returns.md', 'changed')).rejects.toThrow('EROFS');
    expect(await firstWorkspace.fs.readFile('/workspace/notes.md')).toBe(seedText);
    await firstWorkspace.fs.writeFile('/workspace/notes.md', 'thread A changed');

    const reopened = await (first.agent.workspace as AgentWorkspaceResolver)({
      session: session('thread-a'), agentId: 'support',
    }) as typeof firstWorkspace;
    expect(await reopened.fs.readFile('/workspace/notes.md')).toBe('thread A changed');

    const second = await bindAgentVersion({ version, pin: pin(artifact, 'thread-b'), runtime, bindings });
    const secondWorkspace = await (second.agent.workspace as AgentWorkspaceResolver)({
      session: session('thread-b'), agentId: 'support',
    }) as typeof firstWorkspace;
    expect(await secondWorkspace.fs.readFile('/workspace/notes.md')).toBe(seedText);
  });
});
