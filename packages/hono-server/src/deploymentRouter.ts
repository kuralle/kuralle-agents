import { shouldEmit, type StreamEventFilter } from '@kuralle-agents/core';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createUIMessageStreamResponse } from 'ai';
import {
  createRuntime,
  harnessToUIMessageStream,
  resolveExtractedValueStore,
  resolveWorkingMemoryStore,
  sanitizePart,
  scanMemoryWrite,
  scrubSecrets,
  type Extractor,
  type HarnessConfig,
  type LoggedEvent,
  type MemoryBlockScope,
  type SessionEventLog,
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

const SNAPSHOT_LIMIT_DEFAULT = 100;
const SNAPSHOT_LIMIT_MAX = 1000;

function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  param: 'from' | 'limit',
): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  if (param === 'from' && value < 0) return null;
  if (param === 'limit' && value < 1) return null;
  return value;
}

function clampSnapshotLimit(limit: number): number {
  return Math.min(limit, SNAPSHOT_LIMIT_MAX);
}

function parseFollow(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return raw !== 'false' && raw !== '0';
}

function resolveEventLog(options: DeploymentRouterOptions): SessionEventLog | undefined {
  return options.eventLog ?? options.runtimeConfig?.eventLog;
}

function filterLoggedEvent(event: LoggedEvent, streamFilter: StreamEventFilter): LoggedEvent | null {
  if (!shouldEmit(event.part, streamFilter)) return null;
  return {
    ...event,
    part: sanitizePart(event.part),
  };
}

function gateMemoryContent(content: string): string {
  return scanMemoryWrite(content).safe ? content : '';
}

function scrubExtractedValue(value: unknown): unknown {
  const scrubbed = scrubSecrets({
    channel: 'internal',
    type: 'extraction',
    payload: { slug: '', value, changed: false },
  });
  if (scrubbed.type !== 'extraction') return value;
  return scrubbed.payload.value;
}

function memoryOwner(tenantId: string, userId: string): string {
  return scopedKey(tenantId, userId);
}

function ndjsonEventStream(
  source: AsyncIterable<LoggedEvent>,
  streamFilter: StreamEventFilter,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of source) {
          if (cancelled) break;
          const filtered = filterLoggedEvent(event, streamFilter);
          if (!filtered) continue;
          controller.enqueue(encoder.encode(`${JSON.stringify(filtered)}\n`));
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
}

async function snapshotVisibleEvents(
  eventLog: SessionEventLog,
  sessionId: string,
  limit: number,
  streamFilter: StreamEventFilter,
): Promise<{ events: LoggedEvent[]; cursorIndex: number }> {
  const tail = await eventLog.tail(sessionId);
  if (tail < 0) {
    return { events: [], cursorIndex: -1 };
  }

  const visible: LoggedEvent[] = [];
  for (let index = tail; index >= 0 && visible.length < limit; index -= 1) {
    const { events } = await eventLog.read(sessionId, index, 1);
    if (events.length === 0) continue;
    const filtered = filterLoggedEvent(events[0]!, streamFilter);
    if (filtered) visible.unshift(filtered);
  }

  const cursorIndex = visible.length > 0 ? visible[visible.length - 1]!.index : -1;
  return { events: visible, cursorIndex };
}

async function* boundedEventFollow(
  eventLog: SessionEventLog,
  sessionId: string,
  from: number,
  endIndex: number,
): AsyncGenerator<LoggedEvent> {
  let cursor = from;
  while (cursor <= endIndex) {
    const { events, next } = await eventLog.read(sessionId, cursor);
    if (events.length === 0) break;
    for (const event of events) {
      if (event.index > endIndex) return;
      yield event;
    }
    if (next <= cursor) break;
    cursor = next;
  }
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

    const from = parseNonNegativeInt(c.req.query('from'), 0, 'from');
    if (from === null) return c.json({ error: 'from must be a non-negative integer' }, 400);
    const follow = parseFollow(c.req.query('follow'));
    const sessionId = scopedKey(principal.tenantId, c.req.param('sessionId'));

    const source = follow
      ? eventLog.follow(sessionId, from, c.req.raw.signal)
      : boundedEventFollow(eventLog, sessionId, from, await eventLog.tail(sessionId));

    const body = ndjsonEventStream(source, filter);
    const headers = new Headers({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      Connection: 'keep-alive',
    });
    applyNoBufferingHeaders(headers);
    return new Response(body, { headers });
  });

  app.get('/v1/agents/:agentEntityId/sessions/:sessionId/snapshot', async c => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (!eventLog) return c.json({ error: 'event log not configured' }, 503);

    const agentEntityId = c.req.param('agentEntityId');
    const entity = await options.deploymentStore.getEntity(principal.tenantId, agentEntityId);
    if (!entity) return c.json({ error: 'agent not found' }, 404);

    const rawLimit = parseNonNegativeInt(c.req.query('limit'), SNAPSHOT_LIMIT_DEFAULT, 'limit');
    if (rawLimit === null) {
      return c.json({ error: 'limit must be a positive integer' }, 400);
    }
    const limit = clampSnapshotLimit(rawLimit);

    const rawSessionId = c.req.param('sessionId');
    const sessionId = scopedKey(principal.tenantId, rawSessionId);
    const { events, cursorIndex } = await snapshotVisibleEvents(eventLog, sessionId, limit, filter);
    return c.json({
      events,
      cursor: { sessionId: rawSessionId, index: cursorIndex },
    });
  });

  app.post('/v1/agents/:agentEntityId/sessions/:sessionId/cancel', async c => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);

    const agentEntityId = c.req.param('agentEntityId');
    const entity = await options.deploymentStore.getEntity(principal.tenantId, agentEntityId);
    if (!entity) return c.json({ error: 'agent not found' }, 404);

    const sessionKey = scopedKey(principal.tenantId, c.req.param('sessionId'));
    const active = activeTurns.get(sessionKey);
    if (!active) return c.json({ status: 'no_active_turn' });
    active.abort('cancelled');
    return c.json({ status: 'cancelled' });
  });

  app.get('/v1/agents/:agentEntityId/users/:userId/memory', async c => {
    const principal = await options.resolvePrincipal(c);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);

    const requestedUserId = c.req.param('userId');
    if (principal.userId !== requestedUserId) {
      return c.json({ blocks: [], extracted: [] });
    }

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
      const scopedUserOwner = memoryOwner(principal.tenantId, requestedUserId);
      const scopedAgentOwner = scopedKey(principal.tenantId, bound.agent.id);

      const blocks: Array<{
        key: string;
        scope: MemoryBlockScope;
        chars: number;
        limit: number;
        content: string;
      }> = [];

      if (blockStore) {
        const scopes: Array<{ scope: MemoryBlockScope; owner: string }> = [
          { scope: 'user', owner: scopedUserOwner },
          { scope: 'shared', owner: scopedUserOwner },
          { scope: 'agent', owner: scopedAgentOwner },
        ];
        for (const { scope, owner } of scopes) {
          const keys = await blockStore.listBlocks(scope, owner);
          for (const key of keys) {
            const block = await blockStore.loadBlock(scope, owner, key);
            if (!block) continue;
            const content = gateMemoryContent(block.content);
            blocks.push({
              key: block.key,
              scope: block.scope,
              chars: content.length,
              limit: block.charLimit,
              content,
            });
          }
        }
      }

      const extracted: Array<{
        slug: string;
        scope: MemoryBlockScope;
        value: unknown;
        updatedAt: string;
      }> = [];
      for (const extractor of memoryConfig?.extract ?? []) {
        const owner = extractor.scope === 'agent' ? scopedAgentOwner : scopedUserOwner;
        const value = await extractedStore.load(extractor.scope, owner, extractor.slug);
        if (!value) continue;
        extracted.push({
          slug: value.slug,
          scope: value.scope,
          value: scrubExtractedValue(value.value),
          updatedAt: value.updatedAt,
        });
      }

      return c.json({ blocks, extracted });
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
      const runtime = createRuntime({
        ...options.runtimeConfig,
        agents: [bound.agent],
        defaultAgentId: bound.agent.id,
        sessionStore: options.sessionStore,
        eventLog,
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
        userId: principal.userId,
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
