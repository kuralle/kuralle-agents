import { SupportAgent, type SupportEnv } from './agent';
import {
  requireConversationId,
  resolveSupportIdentity,
  scopedSessionId,
} from '../src/identity';

export { SupportAgent };

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
  async fetch(request: Request, env: SupportEnv): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if (origin && !allowedOrigin(origin, url.origin, env.ALLOWED_ORIGINS)) {
      return Response.json({ error: 'Origin is not allowed.' }, { status: 403 });
    }

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), origin);
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return withCors(Response.json({
        status: 'ok',
        runtime: 'cloudflare-durable-object',
        driver: 'pi',
        durability: 'sqlite',
      }), origin);
    }

    try {
      const identity = await resolveSupportIdentity(request, env.SUPPORT_IDENTITY_SECRET, {
        secure: true,
        sameSite: origin && origin !== url.origin ? 'None' : 'Lax',
      });
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        const body = await request.json().catch(() => null) as ChatBody | null;
        if (!body || typeof body.message !== 'string' || !body.message.trim()) {
          return withIdentity(Response.json({ error: 'A non-empty message is required.' }, { status: 400 }), identity.setCookie, origin);
        }
        if (body.message.length > 16_000) {
          return withIdentity(Response.json({ error: 'Message exceeds 16000 characters.' }, { status: 413 }), identity.setCookie, origin);
        }
        const conversationId = requireConversationId(body.conversationId);
        const agent = env.SupportAgent.getByName(scopedSessionId(identity.userId, conversationId));
        const response = await agent.fetch(new Request('https://agent.internal/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-kuralle-user-id': identity.userId,
          },
          body: JSON.stringify({ message: body.message.trim() }),
        }));
        return withIdentity(response, identity.setCookie, origin);
      }

      if (request.method === 'POST' && url.pathname === '/api/chat/approval') {
        const body = await request.json().catch(() => null) as ApprovalBody | null;
        if (!body || typeof body.requestId !== 'string' || !body.requestId.trim()) {
          return withIdentity(Response.json({ error: 'requestId is required.' }, { status: 400 }), identity.setCookie, origin);
        }
        if (body.decision !== 'approve' && body.decision !== 'deny') {
          return withIdentity(Response.json({ error: 'decision must be approve or deny.' }, { status: 400 }), identity.setCookie, origin);
        }
        const conversationId = requireConversationId(body.conversationId);
        const agent = env.SupportAgent.getByName(scopedSessionId(identity.userId, conversationId));
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
      console.error(JSON.stringify({ event: 'support_worker_failed', error: error instanceof Error ? error.message : String(error) }));
      return withCors(Response.json({ error: 'The support request could not be completed.' }, { status: 500 }), origin);
    }

    return withCors(Response.json({
      name: 'Kuralle customer support agent',
      chat: 'POST /api/chat',
      health: 'GET /api/health',
    }), origin);
  },
} satisfies ExportedHandler<SupportEnv>;

function allowedOrigin(origin: string, ownOrigin: string, configured?: string): boolean {
  if (origin === ownOrigin) return true;
  return (configured ?? '').split(',').map((value) => value.trim()).filter(Boolean).includes(origin);
}

function withIdentity(response: Response, setCookie: string | undefined, origin: string | null): Response {
  const headers = new Headers(response.headers);
  if (setCookie) headers.set('set-cookie', setCookie);
  return withCors(new Response(response.body, { status: response.status, statusText: response.statusText, headers }), origin);
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
    headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    headers.set('access-control-allow-headers', 'content-type, x-idempotency-key');
    headers.append('vary', 'Origin');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
