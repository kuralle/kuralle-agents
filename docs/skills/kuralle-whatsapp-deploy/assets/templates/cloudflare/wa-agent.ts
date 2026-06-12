/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';
import { createRuntime } from '@kuralle-agents/core';
import { createOpenAI } from '@ai-sdk/openai';
import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import type { NormalizedMessage } from '@kuralle-agents/messaging-meta/webhooks';
import { buildPharmacyAgent } from './pharmacy.js';
import { SqlSessionStore } from './wa-session-store.js';
import { runWhatsAppTurn, resumeWhatsAppPayment } from './wa-turn.js';

export interface WaEnv {
  OPENAI_API_KEY: string;
  PUBLIC_URL?: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_VERIFY_TOKEN: string;
}

/**
 * One Durable Object per WhatsApp user (`idFromName('wa:' + waId)`). Holds that
 * user's session + durable checkout state in DO SQLite and runs the SAME
 * pharmacy agent the web client uses — only the I/O channel differs.
 */
export class PharmacyWaAgent extends DurableObject<WaEnv> {
  private wire(from: string) {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai('gpt-4o-mini'); // vision-capable: reads the prescription image
    const baseUrl = this.env.PUBLIC_URL ?? 'http://localhost:8787';

    const runtime = createRuntime({
      agents: [buildPharmacyAgent({ model, durableObjectId: from, baseUrl, payPath: '/wa-pay/' })],
      defaultAgentId: 'pharmacy',
      sessionStore: new SqlSessionStore(this.ctx.storage.sql),
    });

    const whatsapp = createWhatsAppClient({
      accessToken: this.env.WHATSAPP_ACCESS_TOKEN,
      appSecret: this.env.WHATSAPP_APP_SECRET,
      phoneNumberId: this.env.WHATSAPP_PHONE_NUMBER_ID,
      verifyToken: this.env.WHATSAPP_VERIFY_TOKEN,
    });

    return { runtime, whatsapp };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/whatsapp') {
      const { from, message } = (await request.json()) as { from: string; message: NormalizedMessage };
      const { runtime, whatsapp } = this.wire(from);
      await runWhatsAppTurn({ runtime, whatsapp, from, message });
      return new Response('ok');
    }

    if (request.method === 'POST' && url.pathname === '/wa-resume') {
      const { from, signalId } = (await request.json()) as { from: string; signalId: string };
      const { runtime, whatsapp } = this.wire(from);
      await resumeWhatsAppPayment({ runtime, whatsapp, from, signalId });
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }
}
