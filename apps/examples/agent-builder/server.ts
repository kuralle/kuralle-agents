/**
 * A runnable agent builder: edit an agent in a browser, publish an immutable
 * version, release it, and chat with the result.
 *
 * Two things this example exists to make concrete, because both are easy to get
 * wrong from the guide alone:
 *
 *   1. Kuralle ships the control-plane MODEL, not a builder API. Everything
 *      under `/api/*` below is application code you own. What you get from the
 *      framework is `DeploymentStore` and its invariants — immutable versions,
 *      compare-and-swap drafts, sticky thread pins, tenant isolation.
 *   2. Tenancy comes from the credential. Two demo tokens map to two tenants,
 *      and they cannot see each other's agents or conversations even when they
 *      use the same thread id.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createOpenAI } from '@ai-sdk/openai';
import { MemoryStore, type AgentConfig } from '@kuralle-agents/core';
import {
  DeploymentError,
  InMemoryDeploymentStore,
  NamedRegistry,
  VersionedRegistry,
  createArtifact,
  sha256,
  type ArtifactInputV1,
  type RuntimeBindings,
  type RuntimeRevision,
} from '@kuralle-agents/deployment';
import {
  createDeploymentRouter,
  type ThreadExecutionCoordinator,
} from '@kuralle-agents/hono-server';

const PORT = Number(process.env.PORT ?? 8787);
const MODEL_ID = process.env.KURALLE_MODEL ?? 'openai/gpt-4.1-mini';
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is required. See README.md.');
  process.exit(1);
}

/** Demo credentials. Real deployments resolve these from your identity provider. */
const TOKENS: Record<string, { tenantId: string; userId: string }> = {
  'demo-acme': { tenantId: 'acme', userId: 'ada@acme.test' },
  'demo-globex': { tenantId: 'globex', userId: 'hank@globex.test' },
};

const principalFrom = (header: string | undefined) => {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  return TOKENS[token] ?? null;
};

const store = new InMemoryDeploymentStore();
const sessionStore = new MemoryStore();

const runtimeRevision: RuntimeRevision = {
  id: 'runtime-1',
  artifactSchemaVersions: [1],
  runtimeApiVersion: '1.0.0',
  capabilities: [],
  createdAt: new Date().toISOString(),
};
await store.registerRuntime(runtimeRevision);

const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
const [provider, ...rest] = MODEL_ID.split('/');
if (provider !== 'openai') throw new Error(`this example supports openai/* only, got ${MODEL_ID}`);
models.register(MODEL_ID, createOpenAI({ apiKey })(rest.join('/')));

const bindings: RuntimeBindings = {
  models,
  tools: new VersionedRegistry(),
  flows: new VersionedRegistry(),
};

/** One turn at a time per (tenant, thread). Production uses a distributed lease. */
const held = new Set<string>();
const coordinator: ThreadExecutionCoordinator = {
  acquire: async ({ tenantId, threadId }) => {
    const lock = `${tenantId}/${threadId}`;
    if (held.has(lock)) return null;
    held.add(lock);
    return { renew: async () => {}, release: async () => { held.delete(lock); } };
  },
};

/** Turns the builder form into the artifact input the store publishes. */
async function definitionFrom(form: {
  agentId: string;
  name: string;
  description: string;
  instructions: string;
  maxTurns: number;
}): Promise<ArtifactInputV1> {
  return {
    schemaVersion: 1,
    artifactId: `${form.agentId}.agent`,
    compiler: { name: 'kuralle', version: '1.0.0' },
    runtimeApiRange: '^1.0.0',
    agent: {
      id: form.agentId,
      name: form.name,
      description: form.description,
      model: MODEL_ID,
      limits: { maxTurns: form.maxTurns },
    },
    instructions: [{
      path: 'instructions.md',
      digest: await sha256(form.instructions),
      bytes: new TextEncoder().encode(form.instructions).byteLength,
      mediaType: 'text/markdown',
      role: 'instructions',
      content: { kind: 'inline', text: form.instructions },
    }],
    skills: [], references: [], workspaceSeed: [], agents: [], tools: [], flows: [],
    policies: {}, requiredCapabilities: [], secretRefs: [], sourceMap: [],
  };
}

type Vars = { Variables: { tenantId: string; userId: string } };
const api = new Hono<Vars>();

// Tenancy is derived from the credential, never from the path or the body.
// Trusting a client-supplied tenantId is the single most common way a builder
// becomes cross-tenant readable.
api.use('*', async (c, next) => {
  const principal = principalFrom(c.req.header('authorization'));
  if (!principal) return c.json({ error: 'unauthorized' }, 401);
  c.set('tenantId', principal.tenantId);
  c.set('userId', principal.userId);
  await next();
});

const draftId = (agentId: string) => `draft-${agentId}`;

api.post('/agents', async c => {
  const { agentId } = await c.req.json<{ agentId: string }>();
  try {
    await store.createEntity({
      id: agentId,
      tenantId: c.get('tenantId'),
      slug: agentId,
      status: 'active',
      ownerId: c.get('userId'),
      visibility: 'private',
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    // Idempotent from the UI's point of view: re-opening an agent is not an error.
    if (!(error instanceof DeploymentError && error.code === 'CONFLICT')) throw error;
  }
  return c.json({ agentId });
});

api.get('/agents/:id/draft', async c => {
  const draft = await store.getDraft(c.get('tenantId'), draftId(c.req.param('id')));
  return c.json({ draft });
});

api.put('/agents/:id/draft', async c => {
  const body = await c.req.json<{ definition: ArtifactInputV1; revision: number }>();
  try {
    const saved = await store.saveDraft({
      id: draftId(c.req.param('id')),
      tenantId: c.get('tenantId'),
      agentEntityId: c.req.param('id'),
      revision: body.revision,
      definition: body.definition,
      updatedBy: c.get('userId'),
      updatedAt: new Date().toISOString(),
    }, body.revision);
    return c.json(saved);
  } catch (error) {
    // Somebody else saved between this client's read and its write. Surface it;
    // retrying with the new revision is last-write-wins with extra steps.
    if (error instanceof DeploymentError && error.code === 'CONFLICT') {
      const current = await store.getDraft(c.get('tenantId'), draftId(c.req.param('id')));
      return c.json({ error: 'conflict', current }, 409);
    }
    throw error;
  }
});

/** Draft (mutable) -> version (immutable) -> release -> live traffic. */
api.post('/agents/:id/publish', async c => {
  const agentId = c.req.param('id');
  const tenantId = c.get('tenantId');
  const body = await c.req.json<{ draftRevision: number; version: number }>();

  const published = await store.publishDraft({
    tenantId,
    draftId: draftId(agentId),
    draftRevision: body.draftRevision,
    versionId: `${agentId}-v${body.version}`,
    version: body.version,
    createdBy: c.get('userId'),
    createdAt: new Date().toISOString(),
  });

  const releaseId = `${agentId}-r${body.version}`;
  await store.createRelease({
    id: releaseId,
    tenantId,
    agentEntityId: agentId,
    environment: 'production',
    allocations: [{
      agentVersionId: published.id,
      runtimeRevisionId: runtimeRevision.id,
      weight: 10_000,
    }],
    createdAt: new Date().toISOString(),
  });
  // Separate from publishing on purpose: rolling back is re-pointing this,
  // with no rebuild and no new version.
  await store.routeTrafficTo(tenantId, releaseId);

  return c.json({
    versionId: published.id,
    releaseId,
    digest: published.artifact.digest,
  });
});

api.post('/agents/:id/definition', async c => {
  const form = await c.req.json<Parameters<typeof definitionFrom>[0]>();
  return c.json(await definitionFrom(form));
});

const app = new Hono();
app.route('/api', api);
app.route('/', createDeploymentRouter({
  deploymentStore: store,
  sessionStore,
  runtimeRevision,
  bindings,
  coordinator,
  // 'all' so the preview pane can show tool and lifecycle events. Production
  // defaults to 'safe', which withholds internal detail from clients.
  streamFilter: 'all',
  resolvePrincipal: c => principalFrom(c.req.header('authorization')),
}));

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  Agent builder API   http://localhost:${PORT}`);
console.log(`  Web UI              run \`bun run dev:web\` in another terminal\n`);
console.log(`  Demo tokens: ${Object.keys(TOKENS).join(', ')}  (two tenants)\n`);
