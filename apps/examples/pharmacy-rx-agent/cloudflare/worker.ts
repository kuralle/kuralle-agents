import { routeAgentRequest } from 'agents';
import { PharmacyAgent } from './agent.js';

export { PharmacyAgent };

const SESSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  headers.set('access-control-allow-headers', 'content-type, authorization');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function parseChat(request: Request): Promise<
  | { ok: true; sessionId: string; message: string }
  | { ok: false; response: Response }
> {
  const body = await request.json().catch(() => null) as {
    sessionId?: unknown;
    message?: unknown;
  } | null;
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return { ok: false, response: Response.json({ error: 'message is required' }, { status: 400 }) };
  }
  const sessionId = typeof body.sessionId === 'string' && body.sessionId
    ? body.sessionId
    : crypto.randomUUID();
  if (!SESSION_PATTERN.test(sessionId)) {
    return { ok: false, response: Response.json({ error: 'invalid sessionId' }, { status: 400 }) };
  }
  return { ok: true, sessionId, message: body.message };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (request.method === 'GET' && url.pathname === '/health') {
      return cors(Response.json({
        status: 'ok',
        runtime: 'cloudflare-durable-object',
        driver: 'pi',
        workspace: 'durable-sqlite',
        skills: 'filesystem-progressive-disclosure',
      }));
    }

    // Stable completion-oriented hosted protocol used by server-side clients and
    // the Vercel facade. Native resumable clients still use /agents/... WebSockets.
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const parsed = await parseChat(request);
      if (!parsed.ok) return cors(parsed.response);
      const agent = env.PharmacyAgent.getByName(parsed.sessionId);
      const response = await agent.fetch(new Request('https://agent.internal/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: parsed.message }),
      }));
      const headers = new Headers(response.headers);
      headers.set('x-kuralle-session-id', parsed.sessionId);
      return cors(new Response(response.body, { status: response.status, headers }));
    }

    const routed = await routeAgentRequest(request, env, { cors: true });
    if (routed) return routed;

    if (request.method === 'GET' && url.pathname === '/') {
      return cors(Response.json({
        name: 'Kuralle Pharmacy Workspace Agent',
        health: '/health',
        httpChat: 'POST /api/chat { sessionId, message }',
        nativeAgent: '/agents/pharmacy-agent/{sessionId}',
      }));
    }

    return cors(Response.json({ error: 'not found' }, { status: 404 }));
  },
} satisfies ExportedHandler<Env>;
