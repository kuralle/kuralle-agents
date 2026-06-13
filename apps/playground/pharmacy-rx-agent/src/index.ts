/// <reference types="@cloudflare/workers-types" />

import { KuralleAgent, BridgeSessionStore } from '@kuralle-agents/cf-agent';
import type { HarnessConfig } from '@kuralle-agents/cf-agent';
import { createOpenAI } from '@ai-sdk/openai';
import { routeAgentRequest } from 'agents';
import type { UIMessage } from 'ai';
import { verifySignature, normalizeWebhook } from '@kuralle-agents/messaging-meta/webhooks';
import { buildPharmacyAgent, finalizeConfirmedOrder } from './pharmacy.js';
import { createPorulleClient } from './porulle.js';
import {
  decodeCheckoutToken,
  AGENT_CALLBACK_SIGNATURE_HEADER,
  verifyCallbackSignature,
} from './token.js';
import {
  recordThread,
  normalizeUiMessages,
  corsJson,
  corsPreflight,
  type ThreadSummary,
} from './admin.js';

export { PharmacyWaAgent } from './wa-agent.js';
export { ConversationRegistry } from './registry-do.js';

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
  /** Commerce API base URL (custom domain). */
  COMMERCE_API_URL?: string;
  /** Shared secret for the deterministic PayHere confirm-callback (signs/verifies). */
  AGENT_CALLBACK_SECRET?: string;
  /** Singleton registry DO indexing conversations for the admin inbox. */
  ConversationRegistry: DurableObjectNamespace;
  /** Bearer-style token the dashboard sends to read the admin inbox. */
  ADMIN_TOKEN?: string;
}

/**
 * One Durable Object per chat thread (= per tenant/customer). CF persists messages
 * + state in this DO; Kuralle runs the pharmacy flow. Closing and reopening the
 * thread replays history from the same DO.
 */
export class PharmacyAgent extends KuralleAgent<Env> {
  protected getAgents(): HarnessConfig['agents'] {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai('gpt-4o'); // vision + stronger instruction-following (resists history-anchored narration on checkout)
    const baseUrl = this.env.PUBLIC_URL ?? 'http://localhost:8787';
    return [
      buildPharmacyAgent({
        model,
        durableObjectId: this.getDurableObjectId(),
        baseUrl,
        payPath: '/payhere-confirmed/',
        storefrontKey: this.env.PORULLE_STOREFRONT_KEY,
        commerceBaseUrl: this.env.COMMERCE_API_URL,
        agentCallbackSecret: this.env.AGENT_CALLBACK_SECRET,
      }),
    ];
  }

  protected getDefaultAgentId(): string {
    return 'pharmacy';
  }

  // Index this web conversation for the admin inbox after each turn (best-effort).
  override async onChatMessage(
    onFinish: Parameters<KuralleAgent<Env>['onChatMessage']>[0],
    options?: Parameters<KuralleAgent<Env>['onChatMessage']>[1],
  ): Promise<Response> {
    const res = await super.onChatMessage(onFinish, options);
    const last = [...this.messages].reverse().find((m) => m.role === 'user');
    const text = (last?.parts ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')
      .trim();
    const id = this.getDurableObjectId();
    void recordThread(this.env.ConversationRegistry, {
      id,
      channel: 'web',
      customer: `web · ${id.slice(0, 8)}`,
      lastText: text || '(message)',
      lastRole: 'user',
      lastAt: Date.now(),
    });
    return res;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Admin inbox: full history for this web thread (worker-authed; internal fetch).
    if (request.method === 'GET' && url.pathname === '/admin/messages') {
      return corsJson({ data: normalizeUiMessages(this.messages) });
    }
    // Deterministic payment confirmation (signed /payhere-confirmed → here). Runs
    // OUT OF BAND (no chat turn): gate on the md5sig-backed status, clear the cart,
    // and broadcast "✅ confirmed" to the live web client via persistMessages.
    if (request.method === 'POST' && url.pathname === '/finalize-payment') {
      const sessionId = this.getDurableObjectId();
      const store = new BridgeSessionStore({
        sqlExecutor: this.getSqlExecutor(),
        cfMessages: this.messages,
        sessionId,
        defaultAgentId: 'pharmacy',
      });
      const commerce = createPorulleClient({
        baseUrl: this.env.COMMERCE_API_URL,
        apiKey: this.env.PORULLE_STOREFRONT_KEY,
        agentCallbackSecret: this.env.AGENT_CALLBACK_SECRET,
      });
      const { paid, text } = await finalizeConfirmedOrder({ sessionStore: store, sessionId, commerce });
      if (paid && text) {
        const assistantMessage: UIMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          parts: [{ type: 'text', text }],
        };
        await this.persistMessages([...this.messages, assistantMessage]);
      }
      return new Response(paid ? 'ok' : 'pending', { status: paid ? 200 : 202 });
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Admin inbox API (read-only) ─────────────────────────────────────────
    // Lets the commerce dashboard list conversations + read a thread's history.
    // Token-gated; CORS-enabled for the dashboard origin. NOTE (demo): the token
    // ships in the dashboard SPA, so anyone with the bundle can read — a real
    // deploy needs proper admin auth (login/session), not a baked-in token.
    if (url.pathname.startsWith('/admin/')) {
      if (request.method === 'OPTIONS') return corsPreflight();
      if (!env.ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
        return corsJson({ error: 'unauthorized' }, 401);
      }
      if (request.method === 'GET' && url.pathname === '/admin/threads') {
        const reg = env.ConversationRegistry.get(env.ConversationRegistry.idFromName('global'));
        const res = await reg.fetch('https://do/list');
        const { data } = (await res.json()) as { data: ThreadSummary[] };
        return corsJson({ data });
      }
      const m = url.pathname.match(/^\/admin\/threads\/([^/]+)\/messages$/);
      if (request.method === 'GET' && m) {
        const id = decodeURIComponent(m[1]!);
        const stub = id.startsWith('wa:')
          ? env.PharmacyWa.get(env.PharmacyWa.idFromName(id))
          : env.PharmacyAgent.get(env.PharmacyAgent.idFromString(id));
        const res = await stub.fetch('https://do/admin/messages');
        return corsJson(await res.json());
      }
      return corsJson({ error: 'not found' }, 404);
    }

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

    // Deterministic payment confirmation from the commerce backend. PayHere
    // notifies the backend, which (once md5sig-verified) POSTs a signed callback
    // here. We verify the HMAC, decode the token to the exact DO + signal, and
    // deliver the durable `payment` signal — resuming the suspended checkout so
    // it confirms WITHOUT any LLM poll. Idempotent: the effect log dedupes.
    if (url.pathname.startsWith('/payhere-confirmed/') && request.method === 'POST') {
      const rawBody = await request.text();
      const signature = request.headers.get(AGENT_CALLBACK_SIGNATURE_HEADER) ?? '';
      const ok = await verifyCallbackSignature(rawBody, signature, env.AGENT_CALLBACK_SECRET ?? '');
      if (!ok) return new Response('Unauthorized', { status: 401 });

      const token = decodeCheckoutToken(url.pathname.slice('/payhere-confirmed/'.length));
      if (!token) return new Response('Bad token', { status: 400 });

      const [platform, phoneNumberId, from] = token.doId.split(':');
      let res: Response;
      if (platform === 'whatsapp' && phoneNumberId && from) {
        // WhatsApp checkout is deterministic (no suspended flow) → finalize out-of-band.
        const stub = env.PharmacyWa.get(env.PharmacyWa.idFromName(`wa:${phoneNumberId}:${from}`));
        res = await stub.fetch('https://do/wa-confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from, phoneNumberId }),
        });
      } else {
        // Web checkout is also deterministic (no suspended flow) → finalize out-of-band.
        const stub = env.PharmacyAgent.get(env.PharmacyAgent.idFromString(token.doId));
        res = await stub.fetch('https://do/finalize-payment', { method: 'POST' });
      }
      return new Response(res.ok ? 'ok' : 'confirm-failed', { status: res.ok ? 200 : 502 });
    }

    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response('Not found', { status: 404 })
    );
  },
};
