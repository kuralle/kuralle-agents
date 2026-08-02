/**
 * Thread ids arrive from a client-controlled URL path segment; the tenant comes
 * from the authenticated principal. Two tenants must be able to use the same
 * thread id without seeing, blocking, or detecting each other.
 *
 * Asserted through the HTTP surface, because that is where the trust boundary
 * is. The vulnerable version returned two 200s here — so these assert on
 * content and on which tenant's data came back, never on status alone.
 */

import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { MemoryStore, type AgentConfig } from '@kuralle-agents/core';
import {
  InMemoryDeploymentStore,
  NamedRegistry,
  VersionedRegistry,
  createArtifact,
  scopedThreadKey,
  sha256,
  type RuntimeBindings,
  type RuntimeRevision,
} from '@kuralle-agents/deployment';
import {
  createDeploymentRouter,
  type ThreadExecutionCoordinator,
} from '../src/deploymentRouter.js';

const AT = '2026-08-01T00:00:00.000Z';
const TENANTS = ['tenant-a', 'tenant-b'] as const;

/** Echoes the conversation length so a reply reveals whose history was loaded. */
function echoingModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const userTurns = prompt.filter(m => m.role === 'user').length;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: `turns=${userTurns}` },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
        }),
      } as never;
    },
  });
}

async function setupTwoTenants() {
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
    skills: [], references: [], workspaceSeed: [], agents: [], tools: [], flows: [],
    policies: {}, requiredCapabilities: [], secretRefs: [], sourceMap: [],
  });

  const deploymentStore = new InMemoryDeploymentStore();
  const runtimeRevision: RuntimeRevision = {
    id: 'runtime-1', artifactSchemaVersions: [1], runtimeApiVersion: '1.0.0',
    capabilities: [], createdAt: AT,
  };
  await deploymentStore.registerRuntime(runtimeRevision);

  // Both tenants run their own release of the same agent — the realistic SaaS shape.
  for (const tenantId of TENANTS) {
    await deploymentStore.createEntity({
      id: 'support', tenantId, slug: 'support', status: 'active',
      ownerId: `owner-${tenantId}`, visibility: 'private', createdAt: AT,
    });
    await deploymentStore.createVersion({
      id: `version-${tenantId}`, tenantId, agentEntityId: 'support', version: 1,
      artifact, createdBy: `owner-${tenantId}`, createdAt: AT,
    });
    await deploymentStore.createRelease({
      id: `release-${tenantId}`, tenantId, agentEntityId: 'support', environment: 'production',
      allocations: [{ agentVersionId: `version-${tenantId}`, runtimeRevisionId: 'runtime-1', weight: 10_000 }],
      createdAt: AT,
    });
    await deploymentStore.routeTrafficTo(tenantId, `release-${tenantId}`);
  }

  const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
  models.register('test/model', echoingModel());
  const bindings: RuntimeBindings = {
    models, tools: new VersionedRegistry(), flows: new VersionedRegistry(),
  };

  // Per-thread lease, keyed the way the router asks for it.
  const held = new Set<string>();
  const coordinator: ThreadExecutionCoordinator = {
    acquire: async ({ tenantId, threadId }) => {
      const key = `${tenantId}::${threadId}`;
      if (held.has(key)) return null;
      held.add(key);
      return { renew: async () => {}, release: async () => { held.delete(key); } };
    },
  };

  const app = createDeploymentRouter({
    deploymentStore,
    sessionStore: new MemoryStore(),
    runtimeRevision,
    bindings,
    coordinator,
    streamFilter: 'all',
    resolvePrincipal: c => {
      const tenantId = c.req.header('authorization')?.replace('Bearer ', '');
      return tenantId ? { tenantId, userId: `user-of-${tenantId}` } : null;
    },
  });

  let delivery = 0;
  const post = async (tenantId: string, threadId: string, message: string) => {
    delivery += 1;
    const res = await app.request(`http://local/v1/agents/support/threads/${threadId}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tenantId}`,
        'content-type': 'application/json',
        'idempotency-key': `delivery-${delivery}`,
      },
      body: JSON.stringify({ message }),
    });
    return { status: res.status, body: await res.text() };
  };

  return { app, deploymentStore, post };
}

describe('deployment tenant isolation', () => {
  it('lets two tenants hold the same thread id without blocking each other', async () => {
    const { post } = await setupTwoTenants();
    const sharedThreadId = '94778984729';

    const first = await post('tenant-a', sharedThreadId, 'hello from A');
    const second = await post('tenant-b', sharedThreadId, 'hello from B');

    expect(first.status).toBe(200);
    // The lockout: today tenant-b is refused because tenant-a claimed the id.
    expect(second.status).toBe(200);
  });

  it('pins each tenant to its own agent version for the same thread id', async () => {
    const { post, deploymentStore } = await setupTwoTenants();
    const sharedThreadId = '94778984729';

    await post('tenant-a', sharedThreadId, 'hello from A');
    await post('tenant-b', sharedThreadId, 'hello from B');

    // Pins are keyed by the composed identity, so ask for them the same way the
    // router stored them.
    const pinA = await deploymentStore.getThreadPin(
      'tenant-a', await scopedThreadKey('tenant-a', sharedThreadId));
    const pinB = await deploymentStore.getThreadPin(
      'tenant-b', await scopedThreadKey('tenant-b', sharedThreadId));

    expect(pinA?.agentVersionId).toBe('version-tenant-a');
    expect(pinB?.agentVersionId).toBe('version-tenant-b');
    // Distinct rows, not one row two tenants share.
    expect(pinA?.threadId).not.toBe(pinB?.threadId);
  });

  it('does not leak conversation history across tenants on a shared thread id', async () => {
    const { post } = await setupTwoTenants();
    const sharedThreadId = '94778984729';

    await post('tenant-a', sharedThreadId, 'first');
    await post('tenant-a', sharedThreadId, 'second');
    const bFirstTurn = await post('tenant-b', sharedThreadId, 'my first message');

    // The model echoes how many user turns it was given. Tenant B's opening
    // turn must be turn 1 — seeing 3 would mean it inherited A's history.
    expect(bFirstTurn.body).toContain('turns=1');
  });
});
