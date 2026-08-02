import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { D1DeploymentStore } from '../src/d1-store.js';
import type {
  D1DatabaseLike,
  D1ResultLike,
  D1StatementLike,
  D1Value,
} from '../src/d1-store.js';
import type { AgentEntity, AgentRelease, RuntimeRevision } from '../src/index.js';
import { artifact, artifactInput } from './fixtures.js';

class BunStatement implements D1StatementLike {
  private values: D1Value[] = [];

  constructor(private readonly database: Database, private readonly sql: string) {}

  bind(...values: D1Value[]): D1StatementLike {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1ResultLike<T>> {
    return { results: this.database.query(this.sql).all(...this.bindings()) as T[] };
  }

  async run(): Promise<D1ResultLike> {
    const result = this.database.query(this.sql).run(...this.bindings());
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  private bindings() {
    return this.values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) as never;
  }
}

function d1(database: Database): D1DatabaseLike {
  return {
    prepare: sql => new BunStatement(database, sql),
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results: D1ResultLike[] = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

const CREATED_AT = '2026-08-01T00:00:00.000Z';

describe('D1 deployment control plane', () => {
  it('publishes database drafts and atomically preserves sticky thread revisions', async () => {
    const store = new D1DeploymentStore({ database: d1(new Database(':memory:')) });
    const entity: AgentEntity = {
      id: 'support', tenantId: 'tenant-a', slug: 'support', status: 'active',
      ownerId: 'owner', visibility: 'tenant', createdAt: CREATED_AT,
    };
    await store.createEntity(entity);
    const draft = await store.saveDraft({
      id: 'draft-1', tenantId: 'tenant-a', agentEntityId: 'support', revision: 0,
      definition: artifactInput(), updatedBy: 'owner', updatedAt: CREATED_AT,
    }, 0);
    expect(draft.revision).toBe(1);
    await expect(store.saveDraft({ ...draft, updatedAt: CREATED_AT }, 0)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const firstVersion = await store.publishDraft({
      tenantId: 'tenant-a', draftId: draft.id, draftRevision: 1, versionId: 'version-1',
      version: 1, createdBy: 'owner', createdAt: CREATED_AT,
    });
    const runtime: RuntimeRevision = {
      id: 'runtime-1', artifactSchemaVersions: [1], runtimeApiVersion: '1.2.0',
      capabilities: [], createdAt: CREATED_AT,
    };
    await store.registerRuntime(runtime);
    const release = (id: string, versionId: string): AgentRelease => ({
      id, tenantId: 'tenant-a', agentEntityId: 'support', environment: 'production',
      allocations: [{ agentVersionId: versionId, runtimeRevisionId: runtime.id, weight: 10_000 }],
      createdAt: CREATED_AT,
    });
    await store.createRelease(release('release-1', firstVersion.id));
    await store.routeTrafficTo('tenant-a', 'release-1');
    const firstPin = await store.assignThread({
      tenantId: 'tenant-a', threadId: 'thread-a', agentEntityId: 'support', environment: 'production',
    });

    await store.createVersion({
      id: 'version-2', tenantId: 'tenant-a', agentEntityId: 'support', version: 2,
      artifact: await artifact({ artifactId: 'support-v2' }), createdBy: 'owner', createdAt: CREATED_AT,
    });
    await store.createRelease(release('release-2', 'version-2'));
    await store.routeTrafficTo('tenant-a', 'release-2');

    expect((await store.assignThread({
      tenantId: 'tenant-a', threadId: 'thread-a', agentEntityId: 'support', environment: 'production',
    })).agentVersionId).toBe('version-1');
    expect((await store.assignThread({
      tenantId: 'tenant-a', threadId: 'thread-b', agentEntityId: 'support', environment: 'production',
    })).agentVersionId).toBe('version-2');
    expect(firstPin.artifactDigest).toBe(firstVersion.artifact.digest);
    // Absent, not denied — a rejection would reveal that another tenant holds it.
    expect(await store.getThreadPin('tenant-b', 'thread-a')).toBeNull();
  });

  it('rekeys a pre-tenant-scoping pin table without losing its rows', async () => {
    const database = new Database(':memory:');
    // The schema exactly as it shipped before tenant scoping: thread_id alone.
    database.exec(`CREATE TABLE kuralle_deploy_thread_pins (
      thread_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,agent_entity_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL,artifact_digest TEXT NOT NULL,runtime_revision_id TEXT NOT NULL,
      release_id TEXT NOT NULL,branch TEXT,environment TEXT NOT NULL,config_generation INTEGER NOT NULL,
      secret_generation INTEGER NOT NULL,assigned_at TEXT NOT NULL)`);
    database.exec(`INSERT INTO kuralle_deploy_thread_pins VALUES (
      'shared-thread','tenant-a','support','legacy-version','${'0'.repeat(64)}',
      'runtime-1','legacy-release',NULL,'production',1,1,'${CREATED_AT}')`);

    // Constructing the store runs migrate(), which must rebuild the table.
    const store = new D1DeploymentStore({ database: d1(database) });
    await store.createEntity({
      id: 'support', tenantId: 'tenant-b', slug: 'support', status: 'active',
      ownerId: 'owner', visibility: 'tenant', createdAt: CREATED_AT,
    });
    await store.registerRuntime({
      id: 'runtime-1', artifactSchemaVersions: [1], runtimeApiVersion: '1.2.0',
      capabilities: [], createdAt: CREATED_AT,
    });
    await store.createVersion({
      id: 'version-b', tenantId: 'tenant-b', agentEntityId: 'support', version: 1,
      artifact: await artifact({ artifactId: 'support-b' }), createdBy: 'owner', createdAt: CREATED_AT,
    });
    await store.createRelease({
      id: 'release-b', tenantId: 'tenant-b', agentEntityId: 'support', environment: 'production',
      allocations: [{ agentVersionId: 'version-b', runtimeRevisionId: 'runtime-1', weight: 10_000 }],
      createdAt: CREATED_AT,
    });
    await store.routeTrafficTo('tenant-b', 'release-b');

    // Without the rebuild this throws: ON CONFLICT(tenant_id,thread_id) matches
    // no constraint on the old single-column key.
    const pinB = await store.assignThread({
      tenantId: 'tenant-b', threadId: 'shared-thread', agentEntityId: 'support',
      environment: 'production',
    });
    expect(pinB.agentVersionId).toBe('version-b');

    // The pre-existing row survived the rebuild, still owned by its own tenant.
    const pinA = await store.getThreadPin('tenant-a', 'shared-thread');
    expect(pinA?.agentVersionId).toBe('legacy-version');

    // Migrating again is a no-op: the second construction must not rebuild or
    // drop anything, or a restart would destroy the table it just fixed.
    const reopened = new D1DeploymentStore({ database: d1(database) });
    expect((await reopened.getThreadPin('tenant-a', 'shared-thread'))?.agentVersionId)
      .toBe('legacy-version');
    expect((await reopened.getThreadPin('tenant-b', 'shared-thread'))?.agentVersionId)
      .toBe('version-b');
  });
});
