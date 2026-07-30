import { z } from 'zod';
import {
  requireConversationId,
  resolveCommerceIdentity,
  scopedSessionId,
} from '../src/identity.js';
import { CommerceAgent } from './agent.js';
import type { CatalogQueueMessage, Env } from './env.js';

export { CommerceAgent };
export { CatalogSyncWorkflow } from './workflows.js';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const catalogSyncBody = z.object({
  documents: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    data: z.record(z.string(), z.unknown()),
  }).strict()).min(1).max(1_000),
}).strict();

interface ChatBody {
  conversationId?: unknown;
  message?: unknown;
}

interface ApprovalBody {
  conversationId?: unknown;
  requestId?: unknown;
  decision?: unknown;
  reason?: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if (origin && !allowedOrigin(origin, url.origin, env.ALLOWED_ORIGINS)) {
      return json({ error: 'Origin is not allowed.' }, 403);
    }
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), origin);
    if (url.pathname === '/healthz') {
      return withCors(json({ ok: true, runtime: 'cloudflare', substrate: 'durable-object' }), origin);
    }
    if (url.pathname === '/admin/catalog-sync' && request.method === 'POST') {
      if (!env.ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const body = catalogSyncBody.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return json({ error: 'documents must contain 1-1000 valid catalog documents' }, 400);
      }
      await env.COMMERCE_EVENTS.send({
        kind: 'catalog.upsert',
        documents: body.data.documents,
      });
      return json({ accepted: true }, 202);
    }

    const isCommerceApi = request.method === 'POST' &&
      (url.pathname === '/api/chat' || url.pathname === '/api/chat/approval');
    if (!isCommerceApi) return env.ASSETS.fetch(request);

    let identity: Awaited<ReturnType<typeof resolveCommerceIdentity>> | undefined;
    try {
      identity = await resolveCommerceIdentity(request, env.COMMERCE_IDENTITY_SECRET, {
        secure: true,
        sameSite: origin && origin !== url.origin ? 'None' : 'Lax',
      });
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        const body = await request.json().catch(() => null) as ChatBody | null;
        if (!body || typeof body.message !== 'string' || !body.message.trim()) {
          return withIdentity(json({ error: 'A non-empty message is required.' }, 400), identity.setCookie, origin);
        }
        if (body.message.length > 16_000) {
          return withIdentity(json({ error: 'Message exceeds 16000 characters.' }, 413), identity.setCookie, origin);
        }
        const conversationId = requireConversationId(body.conversationId);
        const agent = env.CommerceAgent.getByName(scopedSessionId(identity.userId, conversationId));
        const response = await agent.fetch(new Request('https://agent.internal/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-kuralle-user-id': identity.userId,
            ...(request.headers.get('x-idempotency-key')
              ? { 'x-idempotency-key': request.headers.get('x-idempotency-key')! }
              : {}),
          },
          body: JSON.stringify({ message: body.message.trim() }),
        }));
        return withIdentity(response, identity.setCookie, origin);
      }

      if (request.method === 'POST' && url.pathname === '/api/chat/approval') {
        const body = await request.json().catch(() => null) as ApprovalBody | null;
        if (!body || typeof body.requestId !== 'string' || !body.requestId.trim()) {
          return withIdentity(json({ error: 'requestId is required.' }, 400), identity.setCookie, origin);
        }
        if (body.decision !== 'approve' && body.decision !== 'deny') {
          return withIdentity(json({ error: 'decision must be approve or deny.' }, 400), identity.setCookie, origin);
        }
        const conversationId = requireConversationId(body.conversationId);
        const agent = env.CommerceAgent.getByName(scopedSessionId(identity.userId, conversationId));
        const response = await agent.fetch(new Request('https://agent.internal/resume', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-kuralle-user-id': identity.userId,
          },
          body: JSON.stringify({
            signalId: crypto.randomUUID(),
            requestId: body.requestId.trim(),
            name: '__approval',
            decision: body.decision,
            ...(typeof body.reason === 'string' && body.reason.trim()
              ? { reason: body.reason.trim().slice(0, 500) }
              : {}),
          }),
        }));
        return withIdentity(response, identity.setCookie, origin);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const clientError = /required|invalid|exceeds/i.test(message);
      console.error(JSON.stringify({
        event: 'commerce_worker_failed',
        error: message,
      }));
      return withIdentity(
        json({ error: clientError ? message : 'The commerce request could not be completed.' }, clientError ? 400 : 500),
        identity?.setCookie,
        origin,
      );
    }
    return json({ error: 'not found' }, 404);
  },

  async queue(batch: MessageBatch<CatalogQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await env.CATALOG_SYNC_WORKFLOW.create({
          id: `catalog-${message.id}`,
          params: { documents: message.body.documents },
        });
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, CatalogQueueMessage>;

function allowedOrigin(origin: string, ownOrigin: string, configured?: string): boolean {
  if (origin === ownOrigin) return true;
  return (configured ?? '').split(',').map((value) => value.trim()).filter(Boolean).includes(origin);
}

function withIdentity(response: Response, setCookie: string | undefined, origin: string | null): Response {
  const headers = new Headers(response.headers);
  if (setCookie) headers.set('set-cookie', setCookie);
  return withCors(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }), origin);
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
    headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    headers.set('access-control-allow-headers', 'content-type, x-idempotency-key, x-admin-token');
    headers.append('vary', 'Origin');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
