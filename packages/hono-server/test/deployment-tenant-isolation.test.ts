/**
 * A thread id is client-supplied; the tenant is not. The deployment router is
 * the boundary where those two meet, so it is the layer that must compose them
 * before either reaches storage.
 *
 * Pins are keyed by (tenant, thread) inside the store. Conversation history is
 * keyed by `sessionId`, and `SessionStore` has no tenant concept by design —
 * every non-deployment runtime path uses it single-tenant. So the composition
 * belongs here, at the only surface that knows both facts.
 */

import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { MemoryStore, type AgentConfig } from '@kuralle-agents/core';
import {
  InMemoryDeploymentStore,
  NamedRegistry,
  VersionedRegistry,
  createArtifact,
  sha256,
  type RuntimeBindings,
  type RuntimeRevision,
} from '@kuralle-agents/deployment';
import {
  createDeploymentRouter,
  type ThreadExecutionCoordinator,
} from '../src/deploymentRouter.js';

const AT = '2026-08-02T00:00:00.000Z';
const TENANTS = ['tenant-a', 'tenant-b'] as const;

/** Every user-role text the model was ever asked to answer. */
const seenByModel: string[] = [];

async function setup() {
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      for (const message of prompt) {
        if (message.role !== 'user') continue;
        for (const part of message.content) {
          if (part.type === 'text') seenByModel.push(part.text);
        }
      }
      return {
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
      } as never;
    },
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
  for (const tenantId of TENANTS) {
    await deploymentStore.createEntity({
      id: 'support', tenantId, slug: 'support', status: 'active',
      ownerId: tenantId, visibility: 'private', createdAt: AT,
    });
    await deploymentStore.createVersion({
      id: `version-${tenantId}`, tenantId, agentEntityId: 'support', version: 1,
      artifact, createdBy: tenantId, createdAt: AT,
    });
    await deploymentStore.createRelease({
      id: `release-${tenantId}`, tenantId, agentEntityId: 'support', environment: 'production',
      allocations: [{
        agentVersionId: `version-${tenantId}`, runtimeRevisionId: 'runtime-1', weight: 10_000,
      }],
      createdAt: AT,
    });
    await deploymentStore.routeTrafficTo(tenantId, `release-${tenantId}`);
  }

  const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
  models.register('test/model', model as never);
  const bindings: RuntimeBindings = {
    models,
    tools: new VersionedRegistry(),
    flows: new VersionedRegistry(),
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

  const app = createDeploymentRouter({
    deploymentStore,
    sessionStore: new MemoryStore(),
    runtimeRevision,
    bindings,
    coordinator,
    streamFilter: 'all',
    resolvePrincipal: c => {
      const tenantId = c.req.header('authorization')?.replace('Bearer ', '');
      return tenantId ? { tenantId, userId: `${tenantId}-user` } : null;
    },
  });
  return { app, sessionStore: new MemoryStore() };
}

describe('a thread id collision across tenants', () => {
  it('never lets one tenant\'s message reach the other tenant\'s turn', async () => {
    const { app } = await setup();
    // A phone number on the WhatsApp path: the same string is a perfectly
    // ordinary thread id for two different businesses.
    const shared = '94778984729';
    const secret = 'my card number is 4111-1111-1111-1111';

    const send = async (tenantId: string, message: string, key: string) => {
      const res = await app.request(
        `http://local/v1/agents/support/threads/${shared}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tenantId}`,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify({ message }),
        },
      );
      await res.text();
      return res.status;
    };

    seenByModel.length = 0;
    expect(await send('tenant-a', secret, 'a-1')).toBe(200);
    const afterA = seenByModel.length;

    expect(await send('tenant-b', 'hello', 'b-1')).toBe(200);

    // Everything the model saw while answering tenant-b.
    const tenantBTurn = seenByModel.slice(afterA);
    expect(tenantBTurn.length).toBeGreaterThan(0);
    expect(tenantBTurn).not.toContain(secret);
    expect(tenantBTurn.join('\n')).not.toContain('4111');
  });

  it('never emits the internal storage key to the client', async () => {
    const { app } = await setup();
    const threadId = '94778984729';

    const res = await app.request(
      `http://local/v1/agents/support/threads/${threadId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer tenant-a',
          'content-type': 'application/json',
          'idempotency-key': 'leak-1',
        },
        body: JSON.stringify({ message: 'Hello' }),
      },
    );
    const body = await res.text();
    const done = body
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as { sessionId?: string })
      .find(payload => typeof payload.sessionId === 'string');

    // The composed key is addressing. A client that keeps `done.sessionId` and
    // sends it back as a thread id must get a working round trip — the internal
    // form contains `|`, which `validateThreadAssignmentRequest` rejects.
    expect(done?.sessionId).toBe(threadId);
    expect(body).not.toContain('|');
  });

  it('still carries one tenant\'s own history forward across turns', async () => {
    const { app } = await setup();
    const shared = '94778984729';

    const send = async (message: string, key: string) => {
      const res = await app.request(
        `http://local/v1/agents/support/threads/${shared}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer tenant-a',
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify({ message }),
        },
      );
      await res.text();
    };

    seenByModel.length = 0;
    await send('remember: the sky is green', 'own-1');
    const afterFirst = seenByModel.length;
    await send('what colour is the sky?', 'own-2');

    // Scoping the session must not amount to discarding it: the second turn
    // still replays the first. This is what a bare `crypto.randomUUID()`
    // "fix" would break, and it would break silently.
    expect(seenByModel.slice(afterFirst)).toContain('remember: the sky is green');
  });
});
