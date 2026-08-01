import { describe, expect, it } from 'bun:test';
import { newDb } from 'pg-mem';
import {
  createArtifact,
  sha256,
  type AgentArtifact,
  type AgentRelease,
} from '@kuralle-agents/deployment';
import { PostgresDeploymentStore } from '../PostgresDeploymentStore.js';
import { postgresDeploymentMigrationSql } from '../PostgresDeploymentStore.js';
import { PostgresThreadExecutionCoordinator } from '../PostgresThreadExecutionCoordinator.js';

const AT = '2026-08-01T00:00:00.000Z';

async function artifact(name: string, artifactId: string): Promise<AgentArtifact> {
  const instructions = 'You are concise.';
  return createArtifact({
    schemaVersion: 1,
    artifactId,
    compiler: { name: 'kuralle', version: '0.19.0' },
    runtimeApiRange: '^1.0.0',
    agent: { id: 'support', name, model: 'openai/gpt-5-mini' },
    instructions: [{
      path: 'instructions.md',
      digest: await sha256(instructions),
      bytes: new TextEncoder().encode(instructions).byteLength,
      mediaType: 'text/markdown',
      role: 'instructions',
      content: { kind: 'inline', text: instructions },
    }],
    skills: [],
    references: [],
    workspaceSeed: [],
    agents: [],
    tools: [],
    flows: [],
    policies: {},
    requiredCapabilities: [],
    secretRefs: [],
    sourceMap: [],
  });
}

function release(id: string, versionId: string): AgentRelease {
  return {
    id,
    tenantId: 'tenant-a',
    agentEntityId: 'support',
    environment: 'production',
    state: 'active',
    branch: 'main',
    allocations: [{ agentVersionId: versionId, runtimeRevisionId: 'runtime-1', weight: 10_000 }],
    createdAt: AT,
  };
}

describe('PostgresDeploymentStore', () => {
  it('persists drafts, immutable releases, and sticky tenant-isolated thread pins', async () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    const pg = memory.adapters.createPg();
    const pool = new pg.Pool();
    const store = new PostgresDeploymentStore({ client: pool });
    await store.migrate();
    await store.createEntity({
      id: 'support',
      tenantId: 'tenant-a',
      slug: 'support',
      status: 'active',
      ownerId: 'owner-1',
      visibility: 'private',
      createdAt: AT,
    });
    const v1Artifact = await artifact('Support v1', 'support-v1');
    const { digest: _digest, ...definition } = v1Artifact;
    const draft = await store.saveDraft({
      id: 'draft-1',
      tenantId: 'tenant-a',
      agentEntityId: 'support',
      revision: 0,
      definition,
      updatedBy: 'owner-1',
      updatedAt: AT,
    }, 0);
    const v1 = await store.publishDraft({
      tenantId: 'tenant-a',
      draftId: draft.id,
      draftRevision: draft.revision,
      versionId: 'version-1',
      version: 1,
      createdBy: 'owner-1',
      createdAt: AT,
    });
    const v2 = {
      id: 'version-2',
      tenantId: 'tenant-a',
      agentEntityId: 'support',
      version: 2,
      artifact: await artifact('Support v2', 'support-v2'),
      createdBy: 'owner-1',
      createdAt: AT,
    };
    await store.createVersion(v2);
    await store.registerRuntime({
      id: 'runtime-1',
      artifactSchemaVersions: [1],
      runtimeApiVersion: '1.0.0',
      capabilities: [],
      createdAt: AT,
    });
    await store.createRelease(release('release-1', v1.id));
    await store.activateRelease('tenant-a', 'release-1');
    const first = await store.assignThread({
      tenantId: 'tenant-a',
      threadId: 'thread-a',
      agentEntityId: 'support',
      environment: 'production',
      assignedAt: AT,
    });
    await store.createRelease(release('release-2', v2.id));
    await store.activateRelease('tenant-a', 'release-2');

    const afterRestart = new PostgresDeploymentStore({ client: pool, autoMigrate: false });
    const resumed = await afterRestart.assignThread({
      tenantId: 'tenant-a',
      threadId: 'thread-a',
      agentEntityId: 'support',
      environment: 'production',
    });
    const newThread = await afterRestart.assignThread({
      tenantId: 'tenant-a',
      threadId: 'thread-b',
      agentEntityId: 'support',
      environment: 'production',
      assignedAt: AT,
    });

    expect(resumed).toEqual(first);
    expect(newThread.agentVersionId).toBe('version-2');
    await expect(afterRestart.getThreadPin('tenant-b', 'thread-a')).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    await pool.end();
  });

  it('does not change application schema during construction and exposes inspectable migrations', async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [] };
      },
    };

    const store = new PostgresDeploymentStore({ client, tablePrefix: 'app_agents' });
    await Promise.resolve();
    expect(queries).toEqual([]);
    expect(postgresDeploymentMigrationSql({ tablePrefix: 'app_agents' })).toContain(
      'CREATE TABLE IF NOT EXISTS app_agents_agent_entities',
    );
    const schemaSql = postgresDeploymentMigrationSql({
      tablePrefix: 'app_agents',
      schema: 'platform',
    });
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS platform.app_agents_agent_entities');
    expect(schemaSql).toContain('ON platform.app_agents_thread_pins');
    expect(schemaSql).not.toContain('INDEX IF NOT EXISTS platform.');

    await store.migrate();
    expect(queries).toHaveLength(11);
    expect(queries[0]).toBe('BEGIN');
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('uses renewable distributed leases instead of a process-local thread mutex', async () => {
    const memory = newDb();
    const pg = memory.adapters.createPg();
    const pool = new pg.Pool();
    let now = Date.parse(AT);
    const coordinator = new PostgresThreadExecutionCoordinator({ client: pool, now: () => now });
    const first = await coordinator.acquire({
      tenantId: 'tenant-a', threadId: 'thread-a', ownerId: 'node-1', ttlMs: 5_000,
    });
    expect(first).not.toBeNull();
    expect(await coordinator.acquire({
      tenantId: 'tenant-a', threadId: 'thread-a', ownerId: 'node-2', ttlMs: 5_000,
    })).toBeNull();

    now += 5_001;
    const takeover = await coordinator.acquire({
      tenantId: 'tenant-a', threadId: 'thread-a', ownerId: 'node-2', ttlMs: 5_000,
    });
    expect(takeover).not.toBeNull();
    await expect(first!.renew()).rejects.toMatchObject({ code: 'CONFLICT' });
    await takeover!.renew();
    await takeover!.release();
    expect(await coordinator.acquire({
      tenantId: 'tenant-a', threadId: 'thread-a', ownerId: 'node-3', ttlMs: 5_000,
    })).not.toBeNull();
    await pool.end();
  });
});
