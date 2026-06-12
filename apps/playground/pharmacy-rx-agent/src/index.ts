/// <reference types="@cloudflare/workers-types" />

import { KuralleAgent } from '@kuralle-agents/cf-agent';
import type { HarnessConfig } from '@kuralle-agents/cf-agent';
import { createOpenAI } from '@ai-sdk/openai';
import { routeAgentRequest } from 'agents';
import { verifySignature, normalizeWebhook } from '@kuralle-agents/messaging-meta/webhooks';
import { buildPharmacyAgent } from './pharmacy.js';
import { decodeCheckoutToken, PAYMENT_SIGNAL } from './token.js';

export { PharmacyWaAgent } from './wa-agent.js';

interface Env {
  OPENAI_API_KEY: string;
  /** Public base URL of this worker, used to build clickable payment links. */
  PUBLIC_URL?: string;
  PharmacyAgent: DurableObjectNamespace;
  /** Per-WhatsApp-user Durable Object (the WhatsApp channel). */
  PharmacyWa: DurableObjectNamespace;
  // WhatsApp Cloud API credentials (set via `wrangler secret put`).
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_VERIFY_TOKEN: string;
  /** Porulle storefront key for live commerce checkout. */
  PORULLE_STOREFRONT_KEY?: string;
}

/**
 * One Durable Object per chat thread (= per tenant/customer). CF persists messages
 * + state in this DO; Kuralle runs the pharmacy flow. Closing and reopening the
 * thread replays history from the same DO.
 */
export class PharmacyAgent extends KuralleAgent<Env> {
  protected getAgents(): HarnessConfig['agents'] {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai('gpt-4.1-mini'); // vision-capable: reads the prescription image
    const baseUrl = this.env.PUBLIC_URL ?? 'http://localhost:8787';
    return [
      buildPharmacyAgent({
        model,
        durableObjectId: this.getDurableObjectId(),
        baseUrl,
        storefrontKey: this.env.PORULLE_STOREFRONT_KEY,
      }),
    ];
  }

  protected getDefaultAgentId(): string {
    return 'pharmacy';
  }
}

function payPage(ok: boolean): string {
  const msg = ok
    ? '✅ Payment received. Your order is confirmed — return to the chat to see the confirmation.'
    : '⚠️ We could not confirm this payment link. It may have already been used or expired.';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment</title><style>body{font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center}</style>
</head><body><h2>Pharmacy Rx</h2><p>${msg}</p></body></html>`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── WhatsApp channel ────────────────────────────────────────────────────
    // Meta webhook verification handshake (GET hub.challenge).
    if (url.pathname === '/messaging/whatsapp/webhook' && request.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
        return new Response(challenge ?? '', { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    // Inbound WhatsApp messages. Verify HMAC, normalize, fan each message out to
    // its per-user DO. Respond 200 immediately (DO turn runs via waitUntil) so
    // Meta doesn't retry/duplicate while the model thinks.
    if (url.pathname === '/messaging/whatsapp/webhook' && request.method === 'POST') {
      const rawBody = await request.text();
      const signatureHeader = request.headers.get('x-hub-signature-256') ?? '';
      if (!verifySignature({ appSecret: env.WHATSAPP_APP_SECRET, rawBody, signatureHeader })) {
        return new Response('Unauthorized', { status: 401 });
      }
      const events = normalizeWebhook(JSON.parse(rawBody));
      for (const message of events.messages) {
        const from = message.from;
        const phoneNumberId = message.phoneNumberId;
        const stub = env.PharmacyWa.get(env.PharmacyWa.idFromName(`wa:${phoneNumberId}:${from}`));
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

    // WhatsApp payment callback. Routes to the same per-user DO (by name) and
    // resumes the suspended checkout, which pushes "✅ order confirmed" over
    // WhatsApp. Idempotent: the durable effect log dedupes a re-clicked link.
    if (url.pathname.startsWith('/wa-pay/')) {
      const token = decodeCheckoutToken(url.pathname.slice('/wa-pay/'.length));
      if (!token) {
        return new Response(payPage(false), { status: 400, headers: { 'content-type': 'text/html' } });
      }
      const [platform, phoneNumberId, from] = token.doId.split(':');
      const waFrom = platform === 'whatsapp' && phoneNumberId && from ? from : token.doId;
      const waPhoneNumberId = platform === 'whatsapp' && phoneNumberId && from
        ? phoneNumberId
        : env.WHATSAPP_PHONE_NUMBER_ID;
      const stub = env.PharmacyWa.get(env.PharmacyWa.idFromName(`wa:${waPhoneNumberId}:${waFrom}`));
      const res = await stub.fetch('https://do/wa-resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: waFrom, phoneNumberId: waPhoneNumberId, signalId: token.signalId }),
      });
      return new Response(payPage(res.ok), {
        status: res.ok ? 200 : 502,
        headers: { 'content-type': 'text/html' },
      });
    }

    // Payment callback. Hitting this link delivers the durable `payment` signal to
    // the exact DO that minted it, resuming the suspended order → "order completed".
    // Idempotent: the durable effect log dedupes a re-clicked link.
    if (url.pathname.startsWith('/pay/')) {
      const token = decodeCheckoutToken(url.pathname.slice('/pay/'.length));
      if (!token) {
        return new Response(payPage(false), {
          status: 400,
          headers: { 'content-type': 'text/html' },
        });
      }
      const stub = env.PharmacyAgent.get(env.PharmacyAgent.idFromString(token.doId));
      const res = await stub.fetch('https://do/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          signalId: token.signalId,
          name: PAYMENT_SIGNAL,
          payload: { paid: true },
        }),
      });
      return new Response(payPage(res.ok), {
        status: res.ok ? 200 : 502,
        headers: { 'content-type': 'text/html' },
      });
    }

    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response('Not found', { status: 404 })
    );
  },
};
