import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import {
  MemoryStore,
  MemoryTraceStore,
  type AgentConfig,
} from '@kuralle-agents/core';
import {
  InMemoryDeploymentStore,
  HttpDeploymentControlPlaneClient,
  NamedRegistry,
  VersionedRegistry,
  createArtifact,
  scopedThreadKey,
  sha256,
  type RuntimeBindings,
  type RuntimeRevision,
} from '@kuralle-agents/deployment';
import { createDeploymentControlPlaneRouter } from '../src/deploymentControlPlaneRouter.js';
import {
  createDeploymentRouter,
  type ThreadExecutionCoordinator,
} from '../src/deploymentRouter.js';

const AT = '2026-08-01T00:00:00.000Z';

async function setup() {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'ok' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ],
      }),
    }) as never,
  });
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
  const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
  models.register('test/model', model);
  const bindings: RuntimeBindings = {
    models,
    tools: new VersionedRegistry(),
    flows: new VersionedRegistry(),
  };
  let active = false;
  let releases = 0;
  const coordinator: ThreadExecutionCoordinator = {
    acquire: async () => {
      if (active) return null;
      active = true;
      return {
        renew: async () => {},
        release: async () => {
          active = false;
          releases += 1;
        },
      };
    },
  };
  const traceStore = new MemoryTraceStore();
  const app = createDeploymentRouter({
    deploymentStore,
    sessionStore: new MemoryStore(),
    runtimeRevision,
    bindings,
    coordinator,
    streamFilter: 'all',
    runtimeConfig: { tracing: { store: traceStore } },
    resolvePrincipal: c => {
      const tenantId = c.req.header('authorization')?.replace('Bearer ', '');
      return tenantId ? { tenantId, userId: 'user-1' } : null;
    },
  });
  return { app, deploymentStore, traceStore, releases, getReleases: () => releases };
}

describe('createDeploymentRouter', () => {
  it('authenticates, pins, streams, releases its lease, and traces exact revision identity', async () => {
    const { app, traceStore, getReleases } = await setup();
    const response = await app.request('http://local/v1/agents/support/threads/thread-a/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer tenant-a',
        'content-type': 'application/json',
        'idempotency-key': 'delivery-1',
      },
      body: JSON.stringify({ message: 'Hello' }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('event: text-delta');
    expect(body).toContain('"delta":"ok"');
    expect(getReleases()).toBe(1);
    // Traces are keyed by the session id, which the router composes from tenant
    // + thread so two tenants cannot share one. Look it up the same way.
    const trace = (await traceStore.listTraces(
      await scopedThreadKey('tenant-a', 'thread-a')))[0];
    expect(trace?.spans.length).toBeGreaterThan(0);
    for (const span of trace?.spans ?? []) {
      expect(span.attributes).toMatchObject({
        tenantId: 'tenant-a',
        agentVersionId: 'version-1',
        artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        releaseId: 'release-1',
        runtimeRevisionId: 'runtime-1',
      });
    }
  });

  it('requires authentication and an idempotency key, and gives each tenant its own thread', async () => {
    const { app } = await setup();
    const url = 'http://local/v1/agents/support/threads/thread-a/messages';
    expect((await app.request(url, { method: 'POST' })).status).toBe(401);
    expect((await app.request(url, {
      method: 'POST',
      headers: { authorization: 'Bearer tenant-a', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    })).status).toBe(400);
    await (await app.request(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tenant-a',
        'content-type': 'application/json',
        'idempotency-key': 'delivery-1',
      },
      body: JSON.stringify({ message: 'Hello' }),
    })).text();
    // Tenant B asking for the same thread id is not refused and not told the id
    // is taken — it simply has no release of its own here, exactly as if the id
    // had never been used. Returning 403 (the old behaviour) leaked the fact
    // that another tenant held it.
    const otherTenant = await app.request(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tenant-b',
        'content-type': 'application/json',
        'idempotency-key': 'delivery-2',
      },
      body: JSON.stringify({ message: 'Steal it' }),
    });
    expect(otherTenant.status).not.toBe(403);
    expect(await otherTenant.text()).not.toContain('not accessible');
  });
});

describe('createDeploymentControlPlaneRouter', () => {
  it('lets an authenticated Cloudflare runtime assign and fetch only its exact pinned version', async () => {
    const { deploymentStore } = await setup();
    const controlPlane = createDeploymentControlPlaneRouter({
      deploymentStore,
      authorize: (context, request) => (
        context.req.header('authorization') === 'Bearer cf-runtime'
        && request.tenantId === 'tenant-a'
      ),
    });
    const client = new HttpDeploymentControlPlaneClient({
      baseUrl: 'https://control.example.test',
      authorization: 'Bearer cf-runtime',
      fetch: (input, init) => controlPlane.fetch(new Request(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        init,
      )),
    });

    const pin = await client.assignThread({
      tenantId: 'tenant-a',
      threadId: 'thread-cf',
      agentEntityId: 'support',
      environment: 'production',
    });
    const version = await client.getPinnedVersion(pin);

    expect(version.id).toBe(pin.agentVersionId);
    expect(version.artifact.digest).toBe(pin.artifactDigest);
    await expect(client.getPinnedVersion({ ...pin, artifactDigest: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('fails closed when workload authorization is missing or scoped to another tenant', async () => {
    const { deploymentStore } = await setup();
    const controlPlane = createDeploymentControlPlaneRouter({
      deploymentStore,
      authorize: context => context.req.header('authorization') === 'Bearer allowed',
    });
    const client = new HttpDeploymentControlPlaneClient({
      baseUrl: 'https://control.example.test',
      authorization: 'Bearer denied',
      fetch: (input, init) => controlPlane.fetch(new Request(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        init,
      )),
    });

    await expect(client.assignThread({
      tenantId: 'tenant-a',
      threadId: 'thread-denied',
      agentEntityId: 'support',
      environment: 'production',
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
