/**
 * A thread id is client-supplied; the tenant is not. Two tenants using the same
 * thread id must get two independent threads.
 *
 * The tenant belongs in the storage KEY, not in the identity a caller sees:
 * `ThreadPin.threadId` stays the id the caller asked for, so every consumer that
 * compares a pin against its request keeps working. Only the store's own
 * addressing changes.
 */

import { describe, expect, it } from 'bun:test';
import { InMemoryDeploymentStore } from '../src/store.ts';
import { createArtifact, sha256 } from '../src/index.ts';
import type { AgentArtifact } from '../src/types.ts';

const AT = '2026-08-02T00:00:00.000Z';
const TENANTS = ['tenant-a', 'tenant-b'] as const;

async function seed() {
  const instructions = 'Reply briefly.';
  const artifact: AgentArtifact = await createArtifact({
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
    skills: [], references: [], workspaceSeed: [], agents: [], tools: [], flows: [],
    policies: {}, requiredCapabilities: [], secretRefs: [], sourceMap: [],
  });

  const store = new InMemoryDeploymentStore();
  await store.registerRuntime({
    id: 'runtime-1', artifactSchemaVersions: [1], runtimeApiVersion: '1.0.0',
    capabilities: [], createdAt: AT,
  });
  for (const tenantId of TENANTS) {
    await store.createEntity({
      id: 'support', tenantId, slug: 'support', status: 'active',
      ownerId: tenantId, visibility: 'tenant', createdAt: AT,
    });
    await store.createVersion({
      id: `version-${tenantId}`, tenantId, agentEntityId: 'support', version: 1,
      artifact, createdBy: tenantId, createdAt: AT,
    });
    await store.createRelease({
      id: `release-${tenantId}`, tenantId, agentEntityId: 'support', environment: 'production',
      allocations: [{ agentVersionId: `version-${tenantId}`, runtimeRevisionId: 'runtime-1', weight: 10_000 }],
      createdAt: AT,
    });
    await store.routeTrafficTo(tenantId, `release-${tenantId}`);
  }
  return store;
}

const assign = (store: InMemoryDeploymentStore, tenantId: string, threadId: string) =>
  store.assignThread({ tenantId, threadId, agentEntityId: 'support', environment: 'production' });

describe('thread pins are isolated by tenant', () => {
  it('gives two tenants independent pins for the same thread id', async () => {
    const store = await seed();
    const shared = '94778984729';

    const pinA = await assign(store, 'tenant-a', shared);
    const pinB = await assign(store, 'tenant-b', shared);

    expect(pinA.agentVersionId).toBe('version-tenant-a');
    expect(pinB.agentVersionId).toBe('version-tenant-b');
  });

  it('reports the thread id the caller asked for, not an internal key', async () => {
    const store = await seed();
    const shared = '94778984729';

    const pin = await assign(store, 'tenant-a', shared);

    // Consumers compare a returned pin against the request that produced it —
    // cf-agent's SqlThreadPinStore does exactly this before persisting. If the
    // pin reported an internal composite, every such comparison would break.
    expect(pin.threadId).toBe(shared);
  });

  it('does not resolve one tenant\'s pin for another, and does not say why', async () => {
    const store = await seed();
    const shared = '94778984729';
    await assign(store, 'tenant-a', shared);

    // Absent, not denied: distinguishing "another tenant holds this" from
    // "nobody holds this" is an existence oracle over thread ids, which on the
    // WhatsApp path are phone numbers.
    const foreign = await store.getThreadPin('tenant-b', shared);
    expect(foreign).toBeNull();

    const own = await store.getThreadPin('tenant-a', shared);
    expect(own?.agentVersionId).toBe('version-tenant-a');
  });

  it('keeps create-or-read semantics within one tenant', async () => {
    const store = await seed();
    const shared = '94778984729';

    const first = await assign(store, 'tenant-a', shared);
    const second = await assign(store, 'tenant-a', shared);

    expect(second.agentVersionId).toBe(first.agentVersionId);
    expect(second.assignedAt).toBe(first.assignedAt);
  });
});
