import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createUIMessageStreamResponse } from 'ai';
import {
  createRuntime,
  harnessToUIMessageStream,
  type HarnessConfig,
  type SessionStore,
  type StreamPart,
} from '@kuralle-agents/core';
import {
  DeploymentError,
  bindAgentVersion,
  scopedKey,
  type DeploymentStore,
  type RuntimeBindings,
  type RuntimeRevision,
} from '@kuralle-agents/deployment';
import { sanitizeForClient, shouldEmit, type StreamEventFilter } from './streamFilter.js';

/** Same negotiation the chat/flow routes use, so one flag means one thing. */
const wantsRawStreamFormat = (c: Context): boolean => c.req.query('format') === 'raw';

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

export function createDeploymentRouter(options: DeploymentRouterOptions): Hono {
  const app = new Hono();
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const filter = options.streamFilter ?? 'safe';
  const environment = options.environment ?? 'production';

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
      });

      const abort = new AbortController();
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
        sessionId: scopedKey(principal.tenantId, threadId),
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
            yield sanitizeForClient(part);
          }
          await handle;
          if (renewalFailed) throw renewalFailed;
        } finally {
          clearInterval(timer);
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
