/// <reference types="@cloudflare/workers-types" />

import { KuralleAgent } from '@kuralle-agents/cf-agent';
import type { HarnessConfig } from '@kuralle-agents/cf-agent';
import { createOpenAI } from '@ai-sdk/openai';
import { routeAgentRequest } from 'agents';
import { buildPharmacyAgent } from './pharmacy.js';
import { decodeCheckoutToken, PAYMENT_SIGNAL } from './token.js';

interface Env {
  OPENAI_API_KEY: string;
  /** Public base URL of this worker, used to build clickable payment links. */
  PUBLIC_URL?: string;
  PharmacyAgent: DurableObjectNamespace;
}

/**
 * One Durable Object per chat thread (= per tenant/customer). CF persists messages
 * + state in this DO; Kuralle runs the pharmacy flow. Closing and reopening the
 * thread replays history from the same DO.
 */
export class PharmacyAgent extends KuralleAgent<Env> {
  protected getAgents(): HarnessConfig['agents'] {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai('gpt-4o-mini'); // vision-capable: reads the prescription image
    const baseUrl = this.env.PUBLIC_URL ?? 'http://localhost:8787';
    return [
      buildPharmacyAgent({
        model,
        durableObjectId: this.getDurableObjectId(),
        baseUrl,
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
