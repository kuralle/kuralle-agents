import { describe, expect, it } from 'bun:test';
import {
  MemorySessionEventLog,
  readSnapshot,
  type StreamPart,
} from '@kuralle-agents/core';
import {
  InMemoryDeploymentStore,
  NamedRegistry,
  VersionedRegistry,
  createArtifact,
  scopedKey,
  sha256,
  type RuntimeBindings,
  type RuntimeRevision,
} from '@kuralle-agents/deployment';
import {
  createDeploymentRouter,
  type ThreadExecutionCoordinator,
} from '../src/deploymentRouter.js';

const AT = '2026-08-01T00:00:00.000Z';

function textDelta(delta: string): StreamPart {
  return { channel: 'client', type: 'text-delta', payload: { id: 't1', delta } };
}

async function buildRouter(eventLog: MemorySessionEventLog) {
  const instructions = 'Reply briefly.';
  const artifact = await createArtifact({
    schemaVersion: 1,
    artifactId: 'support-v1',
    compiler: { name: 'kuralle', version: '0.19.0' },
    runtimeApiRange: '^1.0.0',
    agent: { id: 'support', model: 'test/model' },
    instructions: [{
      path: 'instructions.md',
      digest: await sha256(instructions),
      bytes: new TextEncoder().encode(instructions).byteLength,
      mediaType: 'text/markdown',
      role: 'instructions',
      content: { kind: 'inline', text: instructions },
    }],
    skills: [], references: [], workspaceSeed: [], agents: [], flows: [],
    tools: [], policies: {}, requiredCapabilities: [], secretRefs: [], sourceMap: [],
  });

  const deploymentStore = new InMemoryDeploymentStore();
  await deploymentStore.createEntity({
    id: 'support', tenantId: 'tenant-a', slug: 'support', status: 'active',
    ownerId: 'owner-1', visibility: 'private', createdAt: AT,
  });
  await deploymentStore.createVersion({
    id: 'version-1', tenantId: 'tenant-a', agentEntityId: 'support', version: 1,
    artifact, createdBy: 'owner-1', createdAt: AT,
  });
  const runtimeRevision: RuntimeRevision = {
    id: 'runtime-1', artifactSchemaVersions: [1], runtimeApiVersion: '1.0.0',
    capabilities: [], createdAt: AT,
  };
  await deploymentStore.registerRuntime(runtimeRevision);
  await deploymentStore.createRelease({
    id: 'release-1', tenantId: 'tenant-a', agentEntityId: 'support', environment: 'production',
    allocations: [{ agentVersionId: 'version-1', runtimeRevisionId: 'runtime-1', weight: 10_000 }],
    createdAt: AT,
  });
  await deploymentStore.routeTrafficTo('tenant-a', 'release-1');

  const coordinator: ThreadExecutionCoordinator = {
    acquire: async () => ({
      renew: async () => {},
      release: async () => {},
    }),
  };

  const app = createDeploymentRouter({
    deploymentStore,
    sessionStore: { get: async () => null, save: async () => {}, delete: async () => {}, list: async () => [] },
    runtimeRevision,
    bindings: {
      models: new NamedRegistry(),
      tools: new VersionedRegistry(),
      flows: new VersionedRegistry(),
    } satisfies RuntimeBindings,
    coordinator,
    eventLog,
    resolvePrincipal: (c) => {
      const tenantId = c.req.header('authorization')?.replace('Bearer ', '');
      return tenantId ? { tenantId, userId: 'user-1' } : null;
    },
  });

  return app;
}

describe('hono-server session route binding', () => {
  it('snapshot transport returns the same status and body as the shared handler', async () => {
    const eventLog = new MemorySessionEventLog();
    const threadId = 'bind-thread';
    const scopedSessionId = scopedKey('tenant-a', threadId);
    await eventLog.append(scopedSessionId, [textDelta('bound')], 'run-1');

    const handlerOutcome = await readSnapshot(
      {
        eventLog,
        memory: { readBlocks: async () => [], readExtracted: async () => [] },
        cancelTurn: async () => 'no_active_turn',
        memoryOwner: () => null,
      },
      scopedSessionId,
      { limit: '10' },
      'all',
      threadId,
    );

    const app = await buildRouter(eventLog);
    const response = await app.request(
      `http://local/v1/agents/support/sessions/${threadId}/snapshot?limit=10`,
      { headers: { authorization: 'Bearer tenant-a' } },
    );

    expect(response.status).toBe(handlerOutcome.status);
    expect(await response.json()).toEqual(handlerOutcome.body);
  });
});
