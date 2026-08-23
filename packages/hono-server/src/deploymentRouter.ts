import { shouldEmit, type StreamEventFilter } from '@kuralle-agents/core';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createUIMessageStreamResponse } from 'ai';
import {
  cancelSession,
  createRuntime,
  harnessToUIMessageStream,
  readEvents,
  readMemory,
  readSnapshot,
  resolveExtractedValueStore,
  resolveWorkingMemoryStore,
  sanitizePart,
  type Extractor,
  type ExtractedValueStore,
  type HarnessConfig,
  type LoggedEvent,
  type MemoryBlockScope,
  type PersistentMemoryStore,
  type SessionEventLog,
  type SessionRouteDeps,
  type SessionStore,
  type StreamPart,
  type WorkingMemoryConfig,
} from '@kuralle-agents/core';
import {
  DeploymentError,
  bindAgentVersion,
  scopedKey,
  type BoundAgentRevision,
  type DeploymentStore,
  type RuntimeBindings,
  type RuntimeRevision,
  type ThreadPin,
} from '@kuralle-agents/deployment';

import { wantsRawStreamFormat } from './streamFormat.js';

export interface DeploymentPrincipal {
  tenantId: string;
  userId: string;
}

export interface ThreadExecutionLease {
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface ThreadExecutionCoordinator {
  acquire(options: {
    tenantId: string;
    threadId: string;
    ownerId: string;
    ttlMs: number;
  }): Promise<ThreadExecutionLease | null>;
}

export interface DeploymentRouterOptions {
  deploymentStore: DeploymentStore;
  sessionStore: SessionStore;
  runtimeRevision: RuntimeRevision;
  bindings: RuntimeBindings;
  coordinator: ThreadExecutionCoordinator;
  resolvePrincipal(c: Context): DeploymentPrincipal | null | Promise<DeploymentPrincipal | null>;
  runtimeConfig?: Omit<Partial<HarnessConfig>, 'agents' | 'defaultAgentId' | 'sessionStore'>;
  eventLog?: SessionEventLog;
  memoryDefaults?: {
    workingMemory?: WorkingMemoryConfig;
    extract?: Extractor<unknown>[];
  };
  streamFilter?: StreamEventFilter;
  leaseTtlMs?: number;
  readiness?: () => void | Promise<void>;
  environment?: string;
  resolveGenerations?: (context: {
    principal: DeploymentPrincipal;
    agentEntityId: string;
  }) => { configGeneration: number; secretGeneration: number } | Promise<{
    configGeneration: number;
    secretGeneration: number;
  }>;
}

interface MessageBody {
  message?: unknown;
}

function statusFor(error: unknown): 403 | 404 | 409 | 500 {
  if (!(error instanceof DeploymentError)) return 500;
  if (error.code === 'ACCESS_DENIED') return 403;
  if (error.code === 'NOT_FOUND') return 404;
  return 409;
}

function applyNoBufferingHeaders(headers: Headers): void {
  headers.set('Cache-Control', 'no-cache, no-transform');
  headers.set('Content-Encoding', 'identity');
  headers.set('X-Accel-Buffering', 'no');
}

function resolveEventLog(options: DeploymentRouterOptions): SessionEventLog | undefined {
  return options.eventLog ?? options.runtimeConfig?.eventLog;
}

function tenantScopeOwner(tenantId: string, owner: string): string {
  return scopedKey(tenantId, owner);
}

function tenantScopeMemoryStore(store: PersistentMemoryStore, tenantId: string): PersistentMemoryStore {
  return {
    async loadBlock(scope, owner, key) {
      return store.loadBlock(scope, tenantScopeOwner(tenantId, owner), key);
    },
    async saveBlock(block, owner) {
      return store.saveBlock(block, tenantScopeOwner(tenantId, owner));
    },
    async deleteBlock(scope, owner, key) {
      return store.deleteBlock(scope, tenantScopeOwner(tenantId, owner), key);
    },
    async listBlocks(scope, owner) {
      return store.listBlocks(scope, tenantScopeOwner(tenantId, owner));
    },
  };
}

function tenantScopeExtractedStore(store: ExtractedValueStore, tenantId: string): ExtractedValueStore {
  return {
    async load(scope, owner, slug) {
      return store.load(scope, tenantScopeOwner(tenantId, owner), slug);
    },
    async save(value, owner) {
      return store.save(value, tenantScopeOwner(tenantId, owner));
    },
    async delete(scope, owner, slug) {
      return store.delete(scope, tenantScopeOwner(tenantId, owner), slug);
    },
  };
}

function ndjsonResponse(source: AsyncIterable<LoggedEvent>): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of source) {
          if (cancelled) break;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        if (!cancelled) controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = new Headers({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    Connection: 'keep-alive',
  });
  applyNoBufferingHeaders(headers);
  return new Response(body, { headers });
}

function buildMemoryDeps(
  blockStore: PersistentMemoryStore | undefined,
  extractedStore: ExtractedValueStore,
  memoryConfig: { extract?: Extractor<unknown>[] } | undefined,
  userOwner: string,
  agentOwner: string,
): SessionRouteDeps['memory'] {
  return {
    readBlocks: async () => {
      const blocks: Array<{ key: string; scope: string; content: string; charLimit: number }> = [];
      if (!blockStore) return blocks;
      const scopes: Array<{ scope: MemoryBlockScope; owner: string }> = [
        { scope: 'user', owner: userOwner },
        { scope: 'shared', owner: userOwner },
        { scope: 'agent', owner: agentOwner },
      ];
      for (const { scope, owner } of scopes) {
        const keys = await blockStore.listBlocks(scope, owner);
        for (const key of keys) {
          const block = await blockStore.loadBlock(scope, owner, key);
          if (!block) continue;
          blocks.push({
            key: block.key,
            scope: block.scope,
            content: block.content,
            charLimit: block.charLimit,
          });
        }
      }
      return blocks;
    },
    readExtracted: async () => {
      const extracted: Array<{ slug: string; scope: string; value: unknown; updatedAt: string }> = [];
      for (const extractor of memoryConfig?.extract ?? []) {
        const owner = extractor.scope === 'agent' ? agentOwner : userOwner;
        const value = await extractedStore.load(extractor.scope, owner, extractor.slug);
        if (!value) continue;
        extracted.push({
          slug: value.slug,
          scope: value.scope,
          value: value.value,
          updatedAt: value.updatedAt,
        });
      }
      return extracted;
    },
  };
}

export function createDeploymentRouter(options: DeploymentRouterOptions): Hono {
  const app = new Hono();
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const filter = options.streamFilter ?? 'safe';
  const environment = options.environment ?? 'production';
  const eventLog = resolveEventLog(options);
  const activeTurns = new Map<string, AbortController>();

  const resolveBoundAgent = async (
    principal: DeploymentPrincipal,
    agentEntityId: string,
    threadId: string,
  ): Promise<{ pin: ThreadPin; bound: BoundAgentRevision }> => {
    const generations = await options.resolveGenerations?.({ principal, agentEntityId }) ?? {
      configGeneration: 1,
      secretGeneration: 1,
    };
    const pin = await options.deploymentStore.assignThread({
      tenantId: principal.tenantId,
      threadId,
      agentEntityId,
      environment,
      configGeneration: generations.configGeneration,
      secretGeneration: generations.secretGeneration,
    });
    const version = await options.deploymentStore.getVersion(principal.tenantId, pin.agentVersionId);
    if (!version) throw new DeploymentError('NOT_FOUND', 'pinned agent version does not exist');
    const bound = await bindAgentVersion({
      version,
      pin,
      runtime: options.runtimeRevision,
      bindings: options.bindings,
    });
    return { pin, bound };
  };

  app.get('/health/live', c => c.json({ status: 'ok' }));
  app.get('/health/ready', async c => {
    try {
      await options.readiness?.();
      if (!options.runtimeRevision.id || !options.runtimeRevision.artifactSchemaVersions.includes(1)) {
        throw new Error('runtime revision is not ready for artifact schema 1');
      }
      return c.json({ status: 'ready', runtimeRevisionId: options.runtimeRevision.id });
    } catch (error) {
      return c.json({
        status: 'not-ready',
        error: error instanceof Error ? error.message : 'readiness failed',
      }, 503);
    }
  });

  app.get('/v1/agents/:agentEntityId/sessions/:sessionId/events', async c => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (!eventLog) return c.json({ error: 'event log not configured' }, 503);

    const agentEntityId = c.req.param('agentEntityId');
    const entity = await options.deploymentStore.getEntity(principal.tenantId, agentEntityId);
    if (!entity) return c.json({ error: 'agent not found' }, 404);

    const sessionId = scopedKey(principal.tenantId, c.req.param('sessionId'));
    const deps: SessionRouteDeps = {
      eventLog,
      memory: { readBlocks: async () => [], readExtracted: async () => [] },
      cancelTurn: async () => 'no_active_turn',
      memoryOwner: () => null,
      abortSignal: c.req.raw.signal,
    };
    const outcome = await readEvents(deps, sessionId, {
      from: c.req.query('from'),
      follow: c.req.query('follow'),
    }, filter);
    if (outcome.ndjson) return ndjsonResponse(outcome.ndjson);
    return Response.json(outcome.body, { status: outcome.status });
  });

  app.get('/v1/agents/:agentEntityId/sessions/:sessionId/snapshot', async c => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (!eventLog) return c.json({ error: 'event log not configured' }, 503);

    const agentEntityId = c.req.param('agentEntityId');
    const entity = await options.deploymentStore.getEntity(principal.tenantId, agentEntityId);
    if (!entity) return c.json({ error: 'agent not found' }, 404);

    const rawSessionId = c.req.param('sessionId');
    const sessionId = scopedKey(principal.tenantId, rawSessionId);
    const deps: SessionRouteDeps = {
      eventLog,
      memory: { readBlocks: async () => [], readExtracted: async () => [] },
      cancelTurn: async () => 'no_active_turn',
      memoryOwner: () => null,
    };
    const outcome = await readSnapshot(deps, sessionId, {
      limit: c.req.query('limit'),
    }, filter, rawSessionId);
    return Response.json(outcome.body, { status: outcome.status });
  });

  app.post('/v1/agents/:agentEntityId/sessions/:sessionId/cancel', async c => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);

    const agentEntityId = c.req.param('agentEntityId');
    const entity = await options.deploymentStore.getEntity(principal.tenantId, agentEntityId);
    if (!entity) return c.json({ error: 'agent not found' }, 404);

    const sessionKey = scopedKey(principal.tenantId, c.req.param('sessionId'));
    const deps: SessionRouteDeps = {
      eventLog: eventLog!,
      memory: { readBlocks: async () => [], readExtracted: async () => [] },
      cancelTurn: async () => {
        const active = activeTurns.get(sessionKey);
        if (!active) return 'no_active_turn';
        active.abort('cancelled');
        return 'cancelled';
      },
      memoryOwner: () => null,
    };
    const outcome = await cancelSession(deps, sessionKey);
    return Response.json(outcome.body, { status: outcome.status });
  });

  app.get('/v1/agents/:agentEntityId/users/:userId/memory', async c => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);

    const requestedUserId = c.req.param('userId');

    try {
      const agentEntityId = c.req.param('agentEntityId');
      const { bound } = await resolveBoundAgent(
        principal,
        agentEntityId,
        `memory.${requestedUserId}`,
      );
      const memoryConfig = bound.agent.memory ?? options.memoryDefaults;
      const workingMemory = memoryConfig?.workingMemory;
      const blockStore = options.runtimeConfig?.defaultWorkingMemoryStore
        ?? (workingMemory
          ? resolveWorkingMemoryStore(workingMemory, options.runtimeConfig?.defaultWorkingMemoryStore)
          : undefined);
      const extractedStore = resolveExtractedValueStore(options.runtimeConfig?.extractedValueStore);

      const deps: SessionRouteDeps = {
        eventLog: eventLog!,
        memory: buildMemoryDeps(
          blockStore,
          extractedStore,
          memoryConfig,
          scopedKey(principal.tenantId, requestedUserId),
          scopedKey(principal.tenantId, bound.agent.id),
        ),
        cancelTurn: async () => 'no_active_turn',
        // Scoped, and the run() call below writes under the same key. A userId is an auth-layer
        // string with no cross-tenant uniqueness guarantee, so comparing userId to userId is not a
        // tenancy check — two tenants can both have "alice". The tenant has to be in the key.
        memoryOwner: (p, userId) => (p.userId === userId ? scopedKey(p.tenantId, userId) : null),
      };
      const outcome = await readMemory(deps, principal, requestedUserId);
      return Response.json(outcome.body, { status: outcome.status });
    } catch (error) {
      const status = statusFor(error);
      const message = status === 500 ? 'internal deployment error' : (error as Error).message;
      if (status === 500) console.error('[Kuralle] deployment memory request failed', error);
      return c.json({ error: message }, status);
    }
  });

  app.post('/v1/agents/:agentEntityId/threads/:threadId/messages', async c => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const agentEntityId = c.req.param('agentEntityId');
    const threadId = c.req.param('threadId');
    const idempotencyKey = c.req.header('idempotency-key');
    if (!idempotencyKey || idempotencyKey.length > 256) {
      return c.json({ error: 'a valid idempotency-key header is required' }, 400);
    }
    const body = await c.req.json<MessageBody>().catch(() => null);
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }
    if (body.message.length > 64_000) return c.json({ error: 'message exceeds 64000 characters' }, 413);
    const message = body.message.trim();

    try {
      const { bound } = await resolveBoundAgent(principal, agentEntityId, threadId);
      const ownerId = crypto.randomUUID();
      const lease = await options.coordinator.acquire({
        tenantId: principal.tenantId,
        threadId,
        ownerId,
        ttlMs: leaseTtlMs,
      });
      if (!lease) return c.json({ error: 'thread already has an active turn' }, 409);
      // Captured after the guard: the narrowing does not reach into the
      // generator declared below.
      const heldLease = lease;
      const baseMemoryStore = options.runtimeConfig?.defaultWorkingMemoryStore;
      const baseExtractedStore = resolveExtractedValueStore(options.runtimeConfig?.extractedValueStore);
      const runtime = createRuntime({
        ...options.runtimeConfig,
        agents: [bound.agent],
        defaultAgentId: bound.agent.id,
        sessionStore: options.sessionStore,
        eventLog,
        ...(baseMemoryStore
          ? { defaultWorkingMemoryStore: tenantScopeMemoryStore(baseMemoryStore, principal.tenantId) }
          : {}),
        extractedValueStore: tenantScopeExtractedStore(baseExtractedStore, principal.tenantId),
      });

      const abort = new AbortController();
      const sessionKey = scopedKey(principal.tenantId, threadId);
      activeTurns.set(sessionKey, abort);
      let renewalFailed: Error | undefined;
      const timer = setInterval(() => {
        void lease.renew().catch(error => {
          renewalFailed = error instanceof Error ? error : new Error('thread lease renewal failed');
          abort.abort(renewalFailed);
        });
      }, Math.max(1_000, Math.floor(leaseTtlMs / 3)));

      const handle = runtime.run({
        input: message,
        // A thread id arrives from the client; the tenant is resolved from the
        // credential. Everything keyed by `sessionId` downstream — history,
        // traces, durable run state — inherits its isolation from this one
        // composition, so it happens once, here.
        sessionId: sessionKey,
        // Same scoped key the memory route reads under; a raw owner here would put every
        // tenant's memory in one keyspace and make the route's tenancy check cosmetic.
        userId: scopedKey(principal.tenantId, principal.userId),
        idempotencyKey,
        abortSignal: abort.signal,
        deployment: bound.deployment,
      });

      /**
       * The filtered part stream both encodings share.
       *
       * The filter has to run BEFORE the encoder: `harnessToUIMessageStream`
       * consumes an iterable directly, so applying `streamFilter` afterwards
       * would mean it never applied at all.
       *
       * Lease release lives in the `finally` so it happens on either path, and
       * whether the stream completes, errors, or the client disconnects.
       */
      async function* clientParts(): AsyncGenerator<StreamPart> {
        try {
          for await (const part of handle.events) {
            if (!shouldEmit(part, filter)) continue;
            yield sanitizePart(part);
          }
          await handle;
          if (renewalFailed) throw renewalFailed;
        } finally {
          clearInterval(timer);
          activeTurns.delete(sessionKey);
          await heldLease.release().catch(error => {
            console.error('[Kuralle] thread lease release failed', error);
          });
        }
      }

      // Raw named-event SSE stays available for non-browser consumers, on the
      // same `?format=raw` negotiation the sibling chat routes already use.
      if (wantsRawStreamFormat(c)) {
        return streamSSE(c, async stream => {
          try {
            for await (const part of clientParts()) {
              // Only the raw wire carries `done`, and `done` is where the
              // composed storage key would escape. The default wire never
              // emits it, so it cannot leak there.
              const payload = 'sessionId' in part.payload
                ? { ...part.payload, sessionId: threadId }
                : part.payload;
              await stream.writeSSE({ event: part.type, data: JSON.stringify(payload) });
            }
          } catch (error) {
            console.error('[Kuralle] deployment stream failed', error);
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ error: 'An error occurred. Please try again.' }),
            });
          }
        });
      }

      // Default: the one wire every Kuralle runtime speaks. `sessionId` is the
      // raw thread id — the composed key is addressing and never crosses this
      // boundary.
      return createUIMessageStreamResponse({
        stream: harnessToUIMessageStream(clientParts(), { sessionId: threadId }),
      });
    } catch (error) {
      const status = statusFor(error);
      const message = status === 500 ? 'internal deployment error' : (error as Error).message;
      if (status === 500) console.error('[Kuralle] deployment request failed', error);
      return c.json({ error: message }, status);
    }
  });

  return app;
}
