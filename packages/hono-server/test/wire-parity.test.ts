/**
 * The deployment thread route must speak the same wire as every other runtime.
 *
 * It cannot be compared frame-for-frame against a fixture the way cf-agent can,
 * because its parts come from a live runtime rather than from an injected
 * array. So this asserts the shape instead: a UIMessageStream body, with the
 * `start` / `text-start` / `finish` framing `useChat` needs, and none of the
 * named-event SSE the route emits today.
 */

import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { MemoryStore, type AgentConfig } from '@kuralle-agents/core';
import { drainSSEFrames } from '@kuralle-agents/core/testing';
import {
  InMemoryDeploymentStore,
  NamedRegistry,
  VersionedRegistry,
  createArtifact,
  sha256,
  type RuntimeBindings,
  type RuntimeRevision,
} from '@kuralle-agents/deployment';
import { createDeploymentRouter, type ThreadExecutionCoordinator } from '../src/deploymentRouter.js';

const AT = '2026-08-02T00:00:00.000Z';

async function setup() {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'ok' },
          { type: 'text-end', id: '1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
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
  const runtimeRevision: RuntimeRevision = {
    id: 'runtime-1', artifactSchemaVersions: [1], runtimeApiVersion: '1.0.0',
    capabilities: [], createdAt: AT,
  };
  await deploymentStore.registerRuntime(runtimeRevision);
  await deploymentStore.createEntity({
    id: 'support', tenantId: 'tenant-a', slug: 'support', status: 'active',
    ownerId: 'owner', visibility: 'private', createdAt: AT,
  });
  await deploymentStore.createVersion({
    id: 'version-1', tenantId: 'tenant-a', agentEntityId: 'support', version: 1,
    artifact, createdBy: 'owner', createdAt: AT,
  });
  await deploymentStore.createRelease({
    id: 'release-1', tenantId: 'tenant-a', agentEntityId: 'support', environment: 'production',
    allocations: [{ agentVersionId: 'version-1', runtimeRevisionId: 'runtime-1', weight: 10_000 }],
    createdAt: AT,
  });
  await deploymentStore.routeTrafficTo('tenant-a', 'release-1');

  const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
  models.register('test/model', model);
  const bindings: RuntimeBindings = {
    models, tools: new VersionedRegistry(), flows: new VersionedRegistry(),
  };
  const held = new Set<string>();
  const coordinator: ThreadExecutionCoordinator = {
    acquire: async ({ tenantId, threadId }) => {
      const lock = `${tenantId}/${threadId}`;
      if (held.has(lock)) return null;
      held.add(lock);
      return { renew: async () => {}, release: async () => { held.delete(lock); } };
    },
  };

  return createDeploymentRouter({
    deploymentStore,
    sessionStore: new MemoryStore(),
    runtimeRevision,
    bindings,
    coordinator,
    streamFilter: 'all',
    resolvePrincipal: c => {
      const tenantId = c.req.header('authorization')?.replace('Bearer ', '');
      return tenantId ? { tenantId, userId: 'user-1' } : null;
    },
  });
}

async function send(app: Awaited<ReturnType<typeof setup>>, query = '') {
  return app.request(`http://local/v1/agents/support/threads/thread-a/messages${query}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer tenant-a',
      'content-type': 'application/json',
      'idempotency-key': `k-${Math.random()}`,
    },
    body: JSON.stringify({ message: 'Hello' }),
  });
}

describe('the deployment thread route speaks UIMessageStream', () => {
  it('emits the framing useChat needs', async () => {
    const app = await setup();
    const frames = await drainSSEFrames((await send(app)).body!);
    const types = frames.map(frame => String(frame.type));

    // `start` and `finish` bracket the message and carry sessionId metadata;
    // without them useChat never completes a message.
    expect(types).toContain('start');
    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('finish');
  });

  it('keeps the text id on the wire', async () => {
    const app = await setup();
    const frames = await drainSSEFrames((await send(app)).body!);
    const start = frames.find(frame => frame.type === 'text-start');
    expect(typeof start?.id).toBe('string');
  });

  it('still offers the raw named-event stream behind an explicit opt-in', async () => {
    const app = await setup();
    const body = await (await send(app, '?format=raw')).text();

    // The raw format survives — this plan changes the DEFAULT, not the set of
    // formats. Non-browser consumers keep the wire they already parse.
    expect(body).toContain('event: text-delta');
  });

  it('never puts the tenant-scoped storage key on the wire', async () => {
    const app = await setup();
    const body = await (await send(app)).text();
    // The composed key contains `|`, which is outside the thread-id charset.
    expect(body).not.toContain('|');
  });
});
