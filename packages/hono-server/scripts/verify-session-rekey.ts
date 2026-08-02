/**
 * Live proof that `rekeySessionsByTenant` preserves a real conversation.
 *
 * Requires OPENAI_API_KEY and network, so it is not part of `bun run test`:
 *
 *   OPENAI_API_KEY=... bun packages/hono-server/scripts/verify-session-rekey.ts
 *
 * Runs the whole flow twice against a real model over real HTTP: once WITHOUT
 * the rekey (history must be lost — that is the defect) and once WITH it
 * (history must replay). A one-sided run would only show that something passed.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { MemoryStore, type AgentConfig, type Session } from '@kuralle-agents/core';
import {
  InMemoryDeploymentStore,
  NamedRegistry,
  VersionedRegistry,
  createArtifact,
  rekeySessionsByTenant,
  scopedKey,
  sha256,
  type RuntimeBindings,
  type RuntimeRevision,
} from '@kuralle-agents/deployment';
import { createDeploymentRouter } from '../src/deploymentRouter.js';

const AT = '2026-08-02T00:00:00.000Z';
const TENANT = 'tenant-a';
const THREAD = '94778984729';
const SECRET = 'ZANZIBAR-7731';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is required');

const instructions = [
  'You are a memory probe. Answer only from this conversation history.',
  '',
  'If the user asks what code word they gave you, reply with exactly that code',
  'word and nothing else. If no code word appears anywhere earlier in this',
  'conversation, reply with exactly `NO CODE WORD IN THIS CONVERSATION` and',
  'nothing else. Never invent a code word.',
].join('\n');

async function buildApp(sessionStore: MemoryStore) {
  const artifact = await createArtifact({
    schemaVersion: 1,
    artifactId: 'probe-v1',
    compiler: { name: 'kuralle', version: '0.19.0' },
    runtimeApiRange: '^1.0.0',
    agent: { id: 'probe', model: 'openai/gpt-4.1-mini' },
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
    id: 'probe', tenantId: TENANT, slug: 'probe', status: 'active',
    ownerId: TENANT, visibility: 'private', createdAt: AT,
  });
  await deploymentStore.createVersion({
    id: 'version-1', tenantId: TENANT, agentEntityId: 'probe', version: 1,
    artifact, createdBy: TENANT, createdAt: AT,
  });
  await deploymentStore.createRelease({
    id: 'release-1', tenantId: TENANT, agentEntityId: 'probe', environment: 'production',
    allocations: [{ agentVersionId: 'version-1', runtimeRevisionId: 'runtime-1', weight: 10_000 }],
    createdAt: AT,
  });
  await deploymentStore.routeTrafficTo(TENANT, 'release-1');

  const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
  models.register('openai/gpt-4.1-mini', createOpenAI({ apiKey })('gpt-4.1-mini'));
  const bindings: RuntimeBindings = {
    models, tools: new VersionedRegistry(), flows: new VersionedRegistry(),
  };
  const held = new Set<string>();
  return createDeploymentRouter({
    deploymentStore,
    sessionStore,
    runtimeRevision,
    bindings,
    streamFilter: 'all',
    coordinator: {
      acquire: async ({ tenantId, threadId }) => {
        const lock = `${tenantId}/${threadId}`;
        if (held.has(lock)) return null;
        held.add(lock);
        return { renew: async () => {}, release: async () => { held.delete(lock); } };
      },
    },
    resolvePrincipal: c => {
      const tenantId = c.req.header('authorization')?.replace('Bearer ', '');
      return tenantId ? { tenantId, userId: `${tenantId}-user` } : null;
    },
  });
}

async function ask(
  app: Awaited<ReturnType<typeof buildApp>>,
  key: string,
  message = 'What was the code word? Repeat it exactly.',
): Promise<string> {
  const res = await app.request(
    `http://local/v1/agents/probe/threads/${THREAD}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TENANT}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ message }),
    },
  );
  const body = await res.text();
  if (!res.ok) return `<HTTP ${res.status}: ${body}>`;
  return body
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => { try { return JSON.parse(line.slice(6)) as { delta?: string }; } catch { return {}; } })
    .map(payload => payload.delta ?? '')
    .join('');
}

/**
 * A store in the state a real pre-upgrade deployment is in: the conversation is
 * genuine runtime output, stored under the RAW thread id the old code used.
 * Building it this way removes any question of a hand-written session being
 * shaped differently from one the runtime made.
 */
async function legacyStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await ask(await buildApp(store), 'seed-1', `Remember this exact code word: ${SECRET}`);
  const created = (await store.list())[0];
  if (!created) throw new Error('seeding produced no session');
  await store.save({ ...created, id: THREAD, version: 0 });
  await store.delete(created.id);
  return store;
}

console.log('=== A. upgrade WITHOUT the rekey (history should be lost) ===');
const without = await legacyStore();
const answerWithout = await ask(await buildApp(without), 'no-rekey-1');
console.log(`  agent: ${answerWithout}`);

console.log('\n=== B. upgrade WITH the rekey (history should replay) ===');
const withRekey = await legacyStore();
const report = await rekeySessionsByTenant({
  sessions: withRekey,
  // The old pin table keyed on thread_id alone, so one query over it yields the
  // owning tenant. Inlined here.
  resolveTenantId: threadId => (threadId === THREAD ? TENANT : null),
});
console.log(`  rekey: ${JSON.stringify(report)}`);
const answerWith = await ask(await buildApp(withRekey), 'rekey-1');
console.log(`  agent: ${answerWith}`);

console.log('\n=============== VERDICT ===============');
const lostWithout = !answerWithout.includes(SECRET);
const keptWith = answerWith.includes(SECRET);
const usable = (t: string) => t.trim().length > 0 && !t.startsWith('<HTTP');
if (!usable(answerWithout) || !usable(answerWith)) {
  console.log('INVALID both runs must produce a real reply — nothing was proven');
  process.exit(1);
}
console.log(lostWithout
  ? 'CONFIRMED  without the rekey the conversation is silently lost'
  : 'UNEXPECTED history survived without the rekey — the probe proves nothing');
console.log(keptWith
  ? 'PASS       with the rekey the conversation replays'
  : 'FAIL       the rekey did not preserve the conversation');
process.exit(lostWithout && keptWith ? 0 : 1);
