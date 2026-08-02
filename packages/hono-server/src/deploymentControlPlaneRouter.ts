import { Hono, type Context } from 'hono';
import {
  DeploymentError,
  resolvePinnedAgentVersion,
  assertRawThreadId,
  scopedThreadKey,
  validateThreadAssignmentRequest,
  validateThreadPin,
  type DeploymentStore,
  type ThreadAssignmentRequest,
} from '@kuralle-agents/deployment';

export interface DeploymentControlPlaneAuthorization {
  action: 'assign-thread' | 'read-pinned-version';
  tenantId: string;
  threadId: string;
}

export interface DeploymentControlPlaneRouterOptions {
  deploymentStore: DeploymentStore;
  authorize(
    context: Context,
    request: DeploymentControlPlaneAuthorization,
  ): boolean | Promise<boolean>;
}

function statusFor(error: unknown): 403 | 404 | 409 | 500 {
  if (!(error instanceof DeploymentError)) return 500;
  if (error.code === 'ACCESS_DENIED') return 403;
  if (error.code === 'NOT_FOUND') return 404;
  return 409;
}

function errorResponse(context: Context, error: unknown) {
  const status = statusFor(error);
  if (status === 500) console.error('[Kuralle] deployment control-plane request failed', error);
  const message = status === 500 ? 'internal deployment control-plane error' : (error as Error).message;
  return context.json({ error: message }, status);
}

/** Internal, authenticated API used by remote runtimes such as Cloudflare Agent Durable Objects. */
export function createDeploymentControlPlaneRouter(
  options: DeploymentControlPlaneRouterOptions,
): Hono {
  const app = new Hono();

  app.post('/v1/internal/deployment/threads/assign', async context => {
    const body = await context.req.json<ThreadAssignmentRequest>().catch(() => null);
    if (!body) return context.json({ error: 'invalid assignment request' }, 400);
    try {
      validateThreadAssignmentRequest(body);
      // Reject a raw id inside the reserved composed namespace. Without this an
      // authorized remote runtime could assign scopedThreadKey(victim, thread)
      // directly and pre-claim another tenant's composed identity.
      assertRawThreadId(body.threadId);
      // Authorize against the id the caller actually named, not the digest.
      if (!await options.authorize(context, {
        action: 'assign-thread', tenantId: body.tenantId, threadId: body.threadId,
      })) {
        return context.json({ error: 'forbidden' }, 403);
      }
      // Compose exactly as the Node router does, so both paths agree on what a
      // thread is. Diverging here would let one path address a thread the other
      // cannot see.
      const pin = await options.deploymentStore.assignThread({
        ...body,
        threadId: await scopedThreadKey(body.tenantId, body.threadId),
      });
      return context.json({ pin });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post('/v1/internal/deployment/threads/pinned-version', async context => {
    const body = await context.req.json<{ pin?: unknown }>().catch(() => null);
    if (!body) return context.json({ error: 'invalid pinned-version request' }, 400);
    try {
      const pin = validateThreadPin(body.pin);
      if (!await options.authorize(context, {
        action: 'read-pinned-version', tenantId: pin.tenantId, threadId: pin.threadId,
      })) {
        return context.json({ error: 'forbidden' }, 403);
      }
      return context.json(await resolvePinnedAgentVersion(options.deploymentStore, pin));
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  return app;
}
