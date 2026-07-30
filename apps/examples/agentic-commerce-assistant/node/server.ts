import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { HitlInterrupt, Runtime, StreamPart } from '@kuralle-agents/core';
import {
  requireConversationId,
  resolveCommerceIdentity,
  scopedSessionId,
} from '../src/identity.js';
import { getRuntime } from './runtime.js';

const app = new Hono();
const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));

app.get('/', async (c) => c.html(await readFile(htmlPath, 'utf8')));
app.get('/healthz', (c) => c.json({ ok: true, runtime: process.release.name, substrate: 'postgres' }));
app.post('/api/chat', async (c) => {
  try {
    const identity = await resolveIdentity(c.req.raw);
    const body = await c.req.json<{ conversationId?: unknown; message?: unknown }>();
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return respond({ error: 'A non-empty message is required.' }, 400, identity.setCookie);
    }
    if (body.message.length > 16_000) {
      return respond({ error: 'Message exceeds 16000 characters.' }, 413, identity.setCookie);
    }
    const conversationId = requireConversationId(body.conversationId);
    const result = await collect((await getRuntime()).run({
      sessionId: scopedSessionId(identity.userId, conversationId),
      userId: identity.userId,
      input: body.message.trim(),
      idempotencyKey: c.req.header('x-idempotency-key'),
    }));
    return respond({ conversationId, ...result }, 200, identity.setCookie);
  } catch (error) {
    return requestError(error);
  }
});
app.post('/api/chat/approval', async (c) => {
  try {
    const identity = await resolveIdentity(c.req.raw);
    const body = await c.req.json<{
      conversationId?: unknown;
      requestId?: unknown;
      decision?: unknown;
      reason?: unknown;
    }>();
    const conversationId = requireConversationId(body.conversationId);
    if (typeof body.requestId !== 'string' || !body.requestId.trim()) {
      return respond({ error: 'requestId is required.' }, 400, identity.setCookie);
    }
    if (body.decision !== 'approve' && body.decision !== 'deny') {
      return respond({ error: 'decision must be approve or deny.' }, 400, identity.setCookie);
    }
    const result = await collect((await getRuntime()).run({
      sessionId: scopedSessionId(identity.userId, conversationId),
      signalDelivery: {
        signalId: crypto.randomUUID(),
        requestId: body.requestId.trim(),
        name: '__approval',
        decision: body.decision,
        actor: { id: identity.userId, type: 'user' },
        ...(typeof body.reason === 'string' && body.reason.trim()
          ? { reason: body.reason.trim().slice(0, 500) }
          : {}),
      },
    }));
    return respond({ conversationId, ...result }, 200, identity.setCookie);
  } catch (error) {
    return requestError(error);
  }
});

async function collect(handle: ReturnType<Runtime['run']>) {
  let response = '';
  let approval: HitlInterrupt | undefined;
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') response += part.payload.delta;
    if (part.type === 'paused' && part.payload.interrupt.kind === 'approval') approval = part.payload.interrupt;
    if (part.type === 'error') throw new Error(part.payload.error);
  }
  await handle;
  return {
    response: response.trim(),
    status: approval ? 'approval-required' : 'completed',
    ...(approval ? { pendingApproval: { requestId: approval.requestId, ...approval.display } } : {}),
  };
}

function resolveIdentity(request: Request) {
  const secret = process.env.COMMERCE_IDENTITY_SECRET ?? '';
  return resolveCommerceIdentity(request, secret, {
    secure: process.env.ENVIRONMENT === 'production',
  });
}

function respond(body: unknown, status: number, setCookie?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (setCookie) headers.set('set-cookie', setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function requestError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (/does not match waitingFor/i.test(message)) {
    return respond({ error: 'No matching approval is pending for this session.' }, 409);
  }
  const clientError = error instanceof SyntaxError || /required|invalid|exceeds/i.test(message);
  if (!clientError) console.error(JSON.stringify({ event: 'commerce_http_failed', error: message }));
  return respond({
    error: clientError || process.env.ENVIRONMENT !== 'production'
      ? message
      : 'The commerce request could not be completed.',
  }, clientError ? 400 : 500);
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => console.log(`Agentic commerce listening on http://localhost:${info.port}`));
