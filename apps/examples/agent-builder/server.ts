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
import { MemoryStore, MemoryTraceStore, type AgentConfig, type AgentTrace } from '@kuralle-agents/core';
import {
  DeploymentError,
  InMemoryDeploymentStore,
  NamedRegistry,
  VersionedRegistry,
  createArtifact,
  scopedKey,
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
/** Spans land here; the Traces tab reads them back per conversation. */
const traceStore = new MemoryTraceStore();

/**
 * Which threads a tenant has talked to, and which versions it has published.
 *
 * Kuralle deliberately has no "list every thread" API — a control plane that
 * enumerates conversations is a different product with different privacy
 * requirements. Owning this registry is the application's job, which is the
 * same boundary the rest of /api/* sits on.
 */
const threadsByTenant = new Map<string, Set<string>>();
interface PublishedVersion {
  versionId: string;
  releaseId: string;
  digest: string;
  version: number;
  publishedAt: string;
}
const versionsByTenant = new Map<string, PublishedVersion[]>();
const liveReleaseByTenant = new Map<string, string>();

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

  const record: PublishedVersion = {
    versionId: published.id,
    releaseId,
    digest: published.artifact.digest,
    version: body.version,
    publishedAt: new Date().toISOString(),
  };
  const history = versionsByTenant.get(tenantId) ?? [];
  history.unshift(record);
  versionsByTenant.set(tenantId, history);
  liveReleaseByTenant.set(tenantId, releaseId);

  return c.json(record);
});

/** Version history, newest first, with the one currently serving traffic marked. */
api.get('/versions', c => {
  const tenantId = c.get('tenantId');
  const live = liveReleaseByTenant.get(tenantId);
  return c.json({
    versions: (versionsByTenant.get(tenantId) ?? [])
      .map(v => ({ ...v, live: v.releaseId === live })),
  });
});

/**
 * Rollback. Immutable releases plus a routing pointer make this one write —
 * no rebuild, no new version, and open conversations keep their pinned version
 * either way.
 */
api.post('/traffic', async c => {
  const { releaseId } = await c.req.json<{ releaseId: string }>();
  const tenantId = c.get('tenantId');
  const known = (versionsByTenant.get(tenantId) ?? []).some(v => v.releaseId === releaseId);
  if (!known) return c.json({ error: 'unknown release for this tenant' }, 404);
  await store.routeTrafficTo(tenantId, releaseId);
  liveReleaseByTenant.set(tenantId, releaseId);
  return c.json({ releaseId });
});

/** Every conversation this tenant has had, with what it pinned. */
api.get('/conversations', async c => {
  const tenantId = c.get('tenantId');
  const threads = [...(threadsByTenant.get(tenantId) ?? [])];
  const rows = await Promise.all(threads.map(async threadId => {
    const session = await sessionStore.get(scopedKey(tenantId, threadId));
    const pin = await store.getThreadPin(tenantId, threadId);
    return {
      threadId,
      turns: session ? session.messages.filter(m => m.role === 'user').length : 0,
      messages: session?.messages.length ?? 0,
      pinnedVersionId: pin?.agentVersionId ?? null,
      artifactDigest: pin?.artifactDigest ?? null,
      updatedAt: session?.updatedAt ?? null,
    };
  }));
  rows.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return c.json({ conversations: rows });
});

/**
 * One conversation: the transcript and the spans, side by side. This is the
 * view LiveKit and Vapi both converge on — a transcript alone cannot tell you
 * why a turn was slow, and spans alone cannot tell you what was said.
 */
api.get('/conversations/:threadId', async c => {
  const tenantId = c.get('tenantId');
  const threadId = c.req.param('threadId');
  const sessionId = scopedKey(tenantId, threadId);
  const session = await sessionStore.get(sessionId);
  const traces: AgentTrace[] = await traceStore.listTraces(sessionId);
  const pin = await store.getThreadPin(tenantId, threadId);

  return c.json({
    threadId,
    // The RAW thread id the caller used. `sessionId` above is a tenant-scoped
    // storage key and never leaves the server.
    pin: pin && {
      agentVersionId: pin.agentVersionId,
      artifactDigest: pin.artifactDigest,
      releaseId: pin.releaseId,
      assignedAt: pin.assignedAt,
    },
    messages: (session?.messages ?? []).map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content),
    })),
    traces: traces.map(t => ({
      traceId: t.traceId,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      durationMs: t.endedAt ? t.endedAt - t.startedAt : null,
      usedTool: t.usedTool,
      answer: t.answer,
      spans: t.spans.map(span => ({
        name: span.name,
        kind: span.kind,
        status: span.status,
        durationMs: span.endTime ? span.endTime - span.startTime : null,
        agentVersionId: span.attributes.agentVersionId ?? null,
        modelId: span.attributes.modelId ?? null,
        inputTokens: span.attributes.inputTokens ?? null,
        outputTokens: span.attributes.outputTokens ?? null,
      })),
    })),
  });
});

api.post('/agents/:id/definition', async c => {
  const form = await c.req.json<Parameters<typeof definitionFrom>[0]>();
  return c.json(await definitionFrom(form));
});

const app = new Hono();
app.route('/api', api);

/**
 * Kuralle has no "list every thread" API, so the application records which
 * threads it has seen. This runs before the deployment router and only notes
 * the pair; the router still owns authentication and everything after it.
 */
app.use('/v1/agents/:agentEntityId/threads/:threadId/messages', async (c, next) => {
  const principal = principalFrom(c.req.header('authorization'));
  if (principal) {
    const seen = threadsByTenant.get(principal.tenantId) ?? new Set<string>();
    seen.add(c.req.param('threadId'));
    threadsByTenant.set(principal.tenantId, seen);
  }
  await next();
});

app.route('/', createDeploymentRouter({
  deploymentStore: store,
  sessionStore,
  runtimeRevision,
  bindings,
  coordinator,
  // 'all' so the preview pane can show tool and lifecycle events. Production
  // defaults to 'safe', which withholds internal detail from clients.
  streamFilter: 'all',
  // Spans are what make the Traces tab possible: turn, llm, and tool spans
  // carrying the deployment identity that produced them.
  runtimeConfig: { tracing: { store: traceStore } },
  resolvePrincipal: c => principalFrom(c.req.header('authorization')),
}));

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  Agent builder API   http://localhost:${PORT}`);
console.log(`  Web UI              run \`bun run dev:web\` in another terminal\n`);
console.log(`  Demo tokens: ${Object.keys(TOKENS).join(', ')}  (two tenants)\n`);
