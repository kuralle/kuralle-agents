/**
 * Deployable WhatsApp bot server — bring your own Cloud API number/token.
 *
 * Usage (from repo root):
 *   bun run packages/messaging-meta/examples/whatsapp-server/server.ts
 *
 * Webhook: https://<host>/messaging/whatsapp/webhook
 */

import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import { fileURLToPath } from 'node:url';
import { createWhatsAppServerApp } from './app.js';
import {
  getMissingWhatsAppEnv,
  printMissingModelInstructions,
  printSetupInstructions,
} from './env.js';
import { resolveLiveModel } from './resolve-model.js';
import { createWindowStore } from './window-store.js';

type BunRuntime = {
  serve: (opts: { fetch: (request: Request) => Response | Promise<Response>; port: number }) => void;
  main: string;
};

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: BunRuntime }).Bun !== 'undefined';
}

function getBun(): BunRuntime {
  return (globalThis as unknown as { Bun: BunRuntime }).Bun;
}

async function main(): Promise<void> {
  const missing = getMissingWhatsAppEnv();
  if (missing.length > 0) {
    printSetupInstructions(missing);
    process.exit(0);
  }

  const live = resolveLiveModel();
  if (!live) {
    printMissingModelInstructions();
    process.exit(0);
  }

  const whatsapp = createWhatsAppClient({
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
    appSecret: process.env.WHATSAPP_APP_SECRET!,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
  });

  const windowStore = await createWindowStore();
  const app = createWhatsAppServerApp({
    whatsapp,
    model: live.model,
    wabaId: process.env.WHATSAPP_WABA_ID!,
    windowStore,
  });

  const port = parseInt(process.env.PORT ?? '3333', 10);

  console.log(`
  WhatsApp server (${live.label}) on port ${port}

  Webhook:     http://localhost:${port}/messaging/whatsapp/webhook
  Health:      http://localhost:${port}/health
  WindowStore: ${process.env.REDIS_URL ? 'redis' : 'in-memory'}
`);

  if (isBunRuntime()) {
    getBun().serve({ fetch: app.fetch, port });
    return;
  }

  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { createWhatsAppServerApp };
