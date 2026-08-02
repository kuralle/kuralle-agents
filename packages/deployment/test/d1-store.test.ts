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
});
