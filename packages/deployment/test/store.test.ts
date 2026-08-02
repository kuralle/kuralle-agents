import { describe, expect, it } from 'bun:test';
import { InMemoryDeploymentStore } from '../src/index.js';
import type {
  AgentEntity,
  AgentRelease,
  AgentVersion,
  RuntimeRevision,
} from '../src/index.js';
import { artifact } from './fixtures.js';

const CREATED_AT = '2026-08-01T00:00:00.000Z';

function entity(tenantId = 'tenant-a'): AgentEntity {
  return {
    id: 'support',
    tenantId,
    slug: 'support',
    status: 'active',
    ownerId: 'owner-1',
    visibility: 'private',
    createdAt: CREATED_AT,
  };
}

function runtime(): RuntimeRevision {
  return {
    id: 'runtime-1',
    artifactSchemaVersions: [1],
    runtimeApiVersion: '1.0.0',
    capabilities: [],
    createdAt: CREATED_AT,
  };
}

async function version(id: string, number: number, name: string): Promise<AgentVersion> {
  return {
    id,
    tenantId: 'tenant-a',
    agentEntityId: 'support',
    version: number,
    artifact: await artifact({
      artifactId: `support-artifact-${number}`,
      agent: { id: 'support', name, model: 'openai/gpt-5-mini' },
    }),
    createdBy: 'owner-1',
    createdAt: CREATED_AT,
  };
}

function release(id: string, versionId: string): AgentRelease {
  return {
    id,
    tenantId: 'tenant-a',
    agentEntityId: 'support',
    environment: 'production',
    branch: 'main',
    allocations: [{ agentVersionId: versionId, runtimeRevisionId: 'runtime-1', weight: 10_000 }],
    createdAt: CREATED_AT,
  };
}

async function configuredStore(): Promise<{
  store: InMemoryDeploymentStore;
  v1: AgentVersion;
  v2: AgentVersion;
}> {
  const store = new InMemoryDeploymentStore();
  const [v1, v2] = await Promise.all([
    version('version-1', 1, 'Support v1'),
    version('version-2', 2, 'Support v2'),
  ]);
  await store.createEntity(entity());
  await store.registerRuntime(runtime());
  await store.createVersion(v1);
  await store.createVersion(v2);
  return { store, v1, v2 };
}

describe('immutable versions and thread pins', () => {
  it('keeps builder drafts mutable through compare-and-swap but production versions append-only', async () => {
    const store = new InMemoryDeploymentStore();
    await store.createEntity(entity());
    const definition = await artifact();
    const { digest: _digest, ...draftDefinition } = definition;
    const first = await store.saveDraft({
      id: 'draft-1',
      tenantId: 'tenant-a',
      agentEntityId: 'support',
      revision: 0,
      definition: draftDefinition,
      updatedBy: 'owner-1',
      updatedAt: CREATED_AT,
    }, 0);
    const second = await store.saveDraft({
      ...first,
      definition: {
        ...first.definition,
        agent: { ...definition.agent, name: 'Edited draft' },
      },
    }, 1);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    await expect(store.saveDraft(first, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    const published = await store.publishDraft({
      tenantId: 'tenant-a',
      draftId: 'draft-1',
      draftRevision: 2,
      versionId: 'draft-version-1',
      version: 1,
      createdBy: 'owner-1',
      createdAt: CREATED_AT,
    });
    expect(published.artifact.agent.name).toBe('Edited draft');
  });

  it('does not permit an existing version id or version number to be overwritten', async () => {
    const { store, v1 } = await configuredStore();

    await expect(store.createVersion(v1)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(store.createVersion({ ...v1, id: 'another-id' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('preserves write-once semantics under concurrent publication', async () => {
    const store = new InMemoryDeploymentStore();
    await store.createEntity(entity());
    const [first, second] = await Promise.all([
      version('race-a', 1, 'First'),
      version('race-b', 1, 'Second'),
    ]);
    const results = await Promise.allSettled([
      store.createVersion(first),
      store.createVersion(second),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('returns defensive copies of immutable published artifacts', async () => {
    const { store } = await configuredStore();
    const first = await store.getVersion('tenant-a', 'version-1');
    first!.artifact.agent.name = 'mutated outside the store';

    const second = await store.getVersion('tenant-a', 'version-1');
    expect(second?.artifact.agent.name).toBe('Support v1');
  });

  it('keeps an existing thread on v1 after activating v2 while new threads receive v2', async () => {
    const { store, v1, v2 } = await configuredStore();
    await store.createRelease(release('release-1', v1.id));
    await store.routeTrafficTo('tenant-a', 'release-1');
    const original = await store.assignThread({
      tenantId: 'tenant-a',
      threadId: 'thread-a',
      agentEntityId: 'support',
      environment: 'production',
      assignedAt: CREATED_AT,
    });

    await store.createRelease(release('release-2', v2.id));
    await store.routeTrafficTo('tenant-a', 'release-2');
    const resumed = await store.assignThread({
      tenantId: 'tenant-a',
      threadId: 'thread-a',
      agentEntityId: 'support',
      environment: 'production',
    });
    const newThread = await store.assignThread({
      tenantId: 'tenant-a',
      threadId: 'thread-b',
      agentEntityId: 'support',
      environment: 'production',
      assignedAt: CREATED_AT,
    });

    expect(original.agentVersionId).toBe('version-1');
    expect(resumed).toEqual(original);
    expect(newThread.agentVersionId).toBe('version-2');
    expect(newThread.releaseId).toBe('release-2');
  });

  it('hides one tenant\'s pin from another without revealing that it exists', async () => {
    const { store } = await configuredStore();
    await store.createRelease(release('release-1', 'version-1'));
    await store.routeTrafficTo('tenant-a', 'release-1');
    await store.assignThread({
      tenantId: 'tenant-a',
      threadId: 'private-thread',
      agentEntityId: 'support',
      environment: 'production',
    });

    // Absent, not denied. ACCESS_DENIED would itself be the existence data:
    // it tells tenant-b that somebody else holds this id.
    expect(await store.getThreadPin('tenant-b', 'private-thread')).toBeNull();
    expect((await store.getThreadPin('tenant-a', 'private-thread'))?.threadId).toBe('private-thread');
  });

  it('makes weighted assignment stable for equivalent control-plane state', async () => {
    async function assign(): Promise<string> {
      const { store, v1, v2 } = await configuredStore();
      await store.createRelease({
        ...release('weighted', v1.id),
        allocations: [
          { agentVersionId: v1.id, runtimeRevisionId: 'runtime-1', weight: 5_000 },
          { agentVersionId: v2.id, runtimeRevisionId: 'runtime-1', weight: 5_000 },
        ],
      });
      await store.routeTrafficTo('tenant-a', 'weighted');
      const pin = await store.assignThread({
        tenantId: 'tenant-a',
        threadId: 'stable-thread',
        agentEntityId: 'support',
        environment: 'production',
        assignedAt: CREATED_AT,
      });
      return pin.agentVersionId;
    }

    expect(await assign()).toBe(await assign());
  });
});
