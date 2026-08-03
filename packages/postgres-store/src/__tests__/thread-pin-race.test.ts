import { describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  createArtifact,
  sha256,
  type AgentRelease,
} from '@kuralle-agents/deployment';
import { PostgresDeploymentStore } from '../PostgresDeploymentStore.js';

/**
 * Opt-in: this test needs a REAL PostgreSQL, because the bug it guards is in
 * PostgreSQL's own transaction semantics — a statement that raises marks the
 * whole transaction aborted, so the old `23505` recovery `SELECT` could only
 * ever return `25P02`. `pg-mem` and any in-memory double model the happy path
 * and would pass against the broken code.
 *
 * Keyed on `POSTGRES_URL` to match `scripts/verify-tenant-migration.ts`. It
 * MUST skip rather than fail when unset: hardcoding a connection string makes
 * `bun run test` pass only on the machine that happens to have that database
 * and fail everywhere else with `3D000`.
 */
const POSTGRES_URL = process.env.POSTGRES_URL;
const AT = '2026-08-01T00:00:00.000Z';

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

async function artifact(name: string, artifactId: string) {
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
    branch: 'main',
    allocations: [{ agentVersionId: versionId, runtimeRevisionId: 'runtime-1', weight: 10_000 }],
    createdAt: AT,
  };
}

describe.skipIf(!POSTGRES_URL)('PostgresDeploymentStore concurrent first-turn pin assignment', () => {
  it('does not abort the transaction when two callers race to pin the same thread', async () => {
    const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 32 });
    const tablePrefix = `pin_race_${Date.now().toString(36)}`;
    const store = new PostgresDeploymentStore({ client: pool, tablePrefix });
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
    const v1Artifact = await artifact('Support v1', `${tablePrefix}-v1`);
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
    await store.registerRuntime({
      id: 'runtime-1',
      artifactSchemaVersions: [1],
      runtimeApiVersion: '1.0.0',
      capabilities: [],
      createdAt: AT,
    });
    await store.createRelease(release('release-1', v1.id));
    await store.routeTrafficTo('tenant-a', 'release-1');

    // One thread id opens exactly ONE race window: once the winner commits,
    // every later caller's `SELECT … FOR UPDATE` finds the row and returns via
    // the existing-pin path without ever reaching the insert. Measured against
    // the pre-fix code, a single thread id caught the regression 2 times in 5.
    //
    // Each fresh thread id re-opens the window, so racing several of them turns
    // a coin-flip into a guard: at the measured ~40% per-window catch rate,
    // eight windows miss only 0.6^8 ≈ 1.7% of the time.
    const THREADS = 8;
    const CALLERS = 16;

    for (let attempt = 0; attempt < THREADS; attempt++) {
      const request = {
        tenantId: 'tenant-a',
        threadId: `thread-${tablePrefix}-${attempt}`,
        agentEntityId: 'support',
        environment: 'production' as const,
        assignedAt: AT,
      };
      const results = await Promise.allSettled(
        Array.from({ length: CALLERS }, () => store.assignThread(request)),
      );

      // `25P02` is the specific signature of the defect: the transaction was
      // already aborted by the unique violation, so the recovery SELECT could
      // never run. Asserted on the SQLSTATE code, never on message text.
      const aborted = results.filter(
        result => result.status === 'rejected' && pgCode(result.reason) === '25P02',
      );
      expect(aborted).toHaveLength(0);
      expect(results.every(result => result.status === 'fulfilled')).toBe(true);

      const pins = results
        .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof store.assignThread>>> =>
          result.status === 'fulfilled')
        .map(result => result.value);
      // Every racing caller must land on the SAME pin — a race resolved by
      // returning two different versions would be worse than an error.
      expect(new Set(pins.map(pin => pin.agentVersionId)).size).toBe(1);
      expect(new Set(pins.map(pin => pin.artifactDigest)).size).toBe(1);
    }

    await pool.end();
  }, { timeout: 60_000 });
});
