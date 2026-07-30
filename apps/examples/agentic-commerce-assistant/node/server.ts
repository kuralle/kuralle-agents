import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { HitlInterrupt, Runtime, StreamPart } from '@kuralle-agents/core';
import { getRuntime } from './runtime.js';

const app = new Hono();
const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));

app.get('/', async (c) => c.html(await readFile(htmlPath, 'utf8')));
app.get('/healthz', (c) => c.json({ ok: true, runtime: process.release.name, substrate: 'postgres' }));
app.post('/api/chat', async (c) => {
  const body = await c.req.json<{ sessionId?: string; message?: string }>();
  if (!body.sessionId?.trim() || !body.message?.trim()) return c.json({ error: 'sessionId and message are required' }, 400);
  return c.json(await collect((await getRuntime()).run({
    sessionId: body.sessionId.trim(),
    input: body.message.trim(),
    idempotencyKey: c.req.header('x-idempotency-key'),
  })));
});
app.post('/api/resume', async (c) => {
  const body = await c.req.json<{ sessionId?: string; requestId?: string; decision?: 'approve' | 'deny'; reason?: string }>();
  if (!body.sessionId || !body.requestId || !['approve', 'deny'].includes(body.decision ?? '')) {
    return c.json({ error: 'sessionId, requestId, and approve/deny decision are required' }, 400);
  }
  return c.json(await collect((await getRuntime()).run({
    sessionId: body.sessionId,
    signalDelivery: {
      signalId: crypto.randomUUID(),
      requestId: body.requestId,
      name: '__approval',
      decision: body.decision!,
      actor: { id: 'node-http-user', type: 'user' },
      reason: body.reason,
    },
  })));
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

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => console.log(`Agentic commerce listening on http://localhost:${info.port}`));
