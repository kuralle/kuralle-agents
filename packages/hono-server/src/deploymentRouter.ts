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
  type SignalDelivery,
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

import { wantsLoggedEventFormat, wantsRawStreamFormat } from './streamFormat.js';

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
  runtimeFactory?: typeof createRuntime;
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

interface ResumeBody {
  signal?: {
    signalId?: unknown;
    requestId?: unknown;
    name?: unknown;
    decision?: 'approve' | 'deny';
    reason?: string;
    payload?: unknown;
    runId?: string;
  };
}

/**
 * What the runtime is asked to do for one turn on a thread.
 *
 * A first message and a resumed approval differ only here. Everything around them — pinning the
 * agent, taking the thread lease, scoping the session key, choosing a wire, releasing the lease —
 * is identical, and used to exist only on the message path. `respond()` against a deployment
 * therefore had nowhere to go: the client posted to `/api/chat/resume`, which this router does not
 * register, and every hosted approval answered 404.
 */
type ThreadTurn =
  | { input: string; idempotencyKey: string }
  | { signalDelivery: SignalDelivery };

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

/**
 * Swap the composed storage key back out for the thread id the caller already knows.
 *
 * `scopedKey(tenantId, threadId)` is addressing. It names the tenant and it shows a caller how keys
 * are built here, so it must not cross this boundary — the raw turn wire has always rewritten it
 * out of `done`. A logged event carries it twice more, in `runId` and in `done.payload.sessionId`,
 * and `/events`, `/snapshot` and the turn stream all serve logged events. One rule, applied
 * wherever one leaves the router.
 *
 * `runId` is rewritten only when it IS the session key, which is the ordinary chat case. A durable
 * flow run mints its own, and that one is the caller's handle on the run.
 */
function withoutStorageKey(event: LoggedEvent, sessionKey: string, threadId: string): LoggedEvent {
  const part = event.part.type === 'done' && event.part.payload.sessionId === sessionKey
    ? { ...event.part, payload: { ...event.part.payload, sessionId: threadId } }
    : event.part;
  return {
    ...event,
    runId: event.runId === sessionKey ? threadId : event.runId,
    part,
  };
}

async function* withoutStorageKeys(
  source: AsyncIterable<LoggedEvent>,
  sessionKey: string,
  threadId: string,
): AsyncGenerator<LoggedEvent> {
  for await (const event of source) yield withoutStorageKey(event, sessionKey, threadId);
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

    const rawSessionId = c.req.param('sessionId');
    const sessionId = scopedKey(principal.tenantId, rawSessionId);
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
    if (outcome.ndjson) {
      return ndjsonResponse(withoutStorageKeys(outcome.ndjson, sessionId, rawSessionId));
    }
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
    const body = outcome.body as { events?: LoggedEvent[] };
    if (!Array.isArray(body.events)) return Response.json(outcome.body, { status: outcome.status });
    return Response.json({
      ...body,
      events: body.events.map(event => withoutStorageKey(event, sessionId, rawSessionId)),
    }, { status: outcome.status });
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

  /**
   * Run one turn on a thread and answer it on the wire the caller negotiated.
   *
   * Shared by `/messages` and `/resume` because the only thing that differs between them is the
   * `ThreadTurn` handed to `runtime.run`.
   */
  const executeThreadTurn = async (
    c: Context,
    principal: DeploymentPrincipal,
    agentEntityId: string,
    threadId: string,
    turn: ThreadTurn,
  ): Promise<Response> => {
    // Negotiated before anything starts. A client asking for logged events on a deployment with no
    // log has to be refused before a lease is taken, not after a turn is already running.
    const wantsLoggedEvents = wantsLoggedEventFormat(c);
    if (wantsLoggedEvents && !eventLog) {
      return c.json({ error: 'event log not configured' }, 503);
    }

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
      const runtime = (options.runtimeFactory ?? createRuntime)({
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

      // The tail before the turn, so the stream below can follow the log from exactly here. Read
      // before run() so nothing this turn writes is already past it.
      const turnFromIndex = eventLog ? (await eventLog.tail(sessionKey)) + 1 : 0;

      const handle = runtime.run({
        ...turn,
        // A thread id arrives from the client; the tenant is resolved from the
        // credential. Everything keyed by `sessionId` downstream — history,
        // traces, durable run state — inherits its isolation from this one
        // composition, so it happens once, here.
        sessionId: sessionKey,
        // Raw on purpose. The runtime is handed tenantScope{Memory,Extracted}Store above, which
        // scopes every owner it is given, so scoping here too wrote under scopedKey(t, scopedKey(t, u))
        // while the memory route read scopedKey(t, u) — the value was written and never findable.
        // One scoping site, and it is the store wrapper.
        userId: principal.userId,
        abortSignal: abort.signal,
        deployment: bound.deployment,
      });

      /** The tail both wires share: settle the turn, then give the lease back whatever happened. */
      async function settleTurn(): Promise<void> {
        await handle;
        if (renewalFailed) throw renewalFailed;
      }
      async function releaseTurn(): Promise<void> {
        clearInterval(timer);
        activeTurns.delete(sessionKey);
        await heldLease.release().catch(error => {
          console.error('[Kuralle] thread lease release failed', error);
        });
      }

      /**
       * The turn as bare parts, for the AI SDK encoder.
       *
       * The filter has to run BEFORE the encoder: `harnessToUIMessageStream` consumes an iterable
       * directly, so applying `streamFilter` afterwards would mean it never applied at all.
       *
       * This reads `handle.events` rather than the log on purpose. `Runtime.emit` appends to the
       * log fire-and-forget and swallows the rejection, so a log-fed default path would silently
       * drop a part from the browser's stream on any write that did not land. This wire carries no
       * index, so it has nothing to gain from the log in exchange.
       */
      async function* clientParts(): AsyncGenerator<StreamPart> {
        try {
          for await (const part of handle.events) {
            if (!shouldEmit(part, filter)) continue;
            yield sanitizePart(part);
          }
          await settleTurn();
        } finally {
          await releaseTurn();
        }
      }

      /**
       * The same turn as logged events, in the encoding `/events` already uses.
       *
       * The log assigns `index`, `eventId` and `at`, so a client that reads this wire and then
       * reads `/snapshot` sees one copy of each event and the server's own timings. The client
       * used to fabricate that envelope instead, numbering from 0 while the log numbered from
       * wherever the session already was; a consumer merging the two matched nothing on index and
       * showed every hosted turn twice.
       */
      async function* clientLoggedEvents(log: SessionEventLog): AsyncGenerator<LoggedEvent> {
        // A successful turn ends this stream by logging `done`. A failed one may never get that
        // far — a resume delivered to a thread with nothing waiting fails before it emits
        // anything — so the failure cuts the follow instead. Only the failure path aborts:
        // `Runtime.emit` appends fire-and-forget, so `done` can land just after the handle
        // resolves, and cutting on success would truncate the tail of a good turn.
        const turnFailed = new AbortController();
        let failure: unknown;
        const settled = settleTurn().catch(error => {
          failure = error ?? new Error('turn failed');
          turnFailed.abort();
        });
        const until = AbortSignal.any([abort.signal, turnFailed.signal]);

        try {
          for await (const event of log.follow(sessionKey, turnFromIndex, until)) {
            if (!shouldEmit(event.part, filter)) continue;
            yield withoutStorageKey({ ...event, part: sanitizePart(event.part) }, sessionKey, threadId);
            if (event.part.type === 'done') break;
          }
          await settled;
          if (failure) throw failure;
        } finally {
          await releaseTurn();
        }
      }

      // Two consumers, two projections of one turn. A browser renders it from the AI SDK
      // UIMessage stream; a Kuralle client stores it, so it reads logged events instead — that is
      // the only wire here carrying the log's index. `sessionId` is the raw thread id; the
      // composed storage key is addressing and never crosses this boundary.
      if (wantsLoggedEvents && eventLog) {
        return ndjsonResponse(clientLoggedEvents(eventLog));
      }

      // Raw named-event SSE stays available for non-browser consumers, on the same negotiation the
      // sibling chat routes already use. It predates `format=events` and nothing in this repo asks
      // for it, but it is a published HTTP surface, so it keeps the exact shape it shipped with.
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

      return createUIMessageStreamResponse({
        stream: harnessToUIMessageStream(clientParts(), { sessionId: threadId }),
      });
    } catch (error) {
      const status = statusFor(error);
      const message = status === 500 ? 'internal deployment error' : (error as Error).message;
      if (status === 500) console.error('[Kuralle] deployment request failed', error);
      return c.json({ error: message }, status);
    }
  };

  app.post('/v1/agents/:agentEntityId/threads/:threadId/messages', async c => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const idempotencyKey = c.req.header('idempotency-key');
    if (!idempotencyKey || idempotencyKey.length > 256) {
      return c.json({ error: 'a valid idempotency-key header is required' }, 400);
    }
    const body = await c.req.json<MessageBody>().catch(() => null);
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }
    if (body.message.length > 64_000) return c.json({ error: 'message exceeds 64000 characters' }, 413);

    return executeThreadTurn(
      c,
      principal,
      c.req.param('agentEntityId'),
      c.req.param('threadId'),
      { input: body.message.trim(), idempotencyKey },
    );
  });

  app.post('/v1/agents/:agentEntityId/threads/:threadId/resume', async c => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const body = await c.req.json<ResumeBody>().catch(() => null);
    const signal = body?.signal;
    if (
      typeof signal?.signalId !== 'string' ||
      typeof signal.requestId !== 'string' ||
      typeof signal.name !== 'string'
    ) {
      return c.json({ error: 'signal { signalId, requestId, name } is required' }, 400);
    }

    return executeThreadTurn(
      c,
      principal,
      c.req.param('agentEntityId'),
      c.req.param('threadId'),
      {
        signalDelivery: {
          signalId: signal.signalId,
          requestId: signal.requestId,
          name: signal.name,
          // Never from the body. A client that names its own actor approves as anyone, and the
          // credential already says who this is.
          actor: { id: principal.userId, type: 'user' },
          ...(signal.decision ? { decision: signal.decision } : {}),
          ...(signal.reason ? { reason: signal.reason } : {}),
          ...(signal.payload !== undefined ? { payload: signal.payload } : {}),
          ...(signal.runId ? { runId: signal.runId } : {}),
        },
      },
    );
  });

  return app;
}
