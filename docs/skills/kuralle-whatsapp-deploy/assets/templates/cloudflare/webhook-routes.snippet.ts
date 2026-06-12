// Add these to your Worker's default-export fetch handler, BEFORE any other
// routing (e.g. before routeAgentRequest / your web routes). Requires:
//   import { verifySignature, normalizeWebhook } from '@kuralle-agents/messaging-meta/webhooks';
//   import { decodeCheckoutToken, PAYMENT_SIGNAL } from './token.js';
//   export { PharmacyWaAgent } from './wa-agent.js';   // register the DO
//
// Env needs: PharmacyWa (DurableObjectNamespace) + the WHATSAPP_* secrets.
// Note the (request, env, ctx) signature — ctx.waitUntil lets us 200 fast so
// Meta doesn't retry/duplicate while the model is thinking.

// ── Meta webhook verification handshake (GET) ──────────────────────────────
if (url.pathname === '/messaging/whatsapp/webhook' && request.method === 'GET') {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge ?? '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// ── Inbound messages (POST) ────────────────────────────────────────────────
if (url.pathname === '/messaging/whatsapp/webhook' && request.method === 'POST') {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get('x-hub-signature-256') ?? '';
  if (!verifySignature({ appSecret: env.WHATSAPP_APP_SECRET, rawBody, signatureHeader })) {
    return new Response('Unauthorized', { status: 401 });
  }
  const events = normalizeWebhook(JSON.parse(rawBody));
  for (const message of events.messages) {
    const from = message.from;
    const stub = env.PharmacyWa.get(env.PharmacyWa.idFromName(`wa:${from}`));
    ctx.waitUntil(
      stub.fetch('https://do/whatsapp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, message }),
      }),
    );
  }
  return new Response('OK', { status: 200 });
}

// ── Payment callback → resume the suspended checkout (durable HITL) ─────────
if (url.pathname.startsWith('/wa-pay/')) {
  const token = decodeCheckoutToken(url.pathname.slice('/wa-pay/'.length));
  if (!token) return new Response('Invalid link', { status: 400 });
  const stub = env.PharmacyWa.get(env.PharmacyWa.idFromName(`wa:${token.doId}`));
  const res = await stub.fetch('https://do/wa-resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: token.doId, signalId: token.signalId }),
  });
  return new Response(res.ok ? 'Payment received.' : 'Could not confirm.', {
    status: res.ok ? 200 : 502,
  });
}
