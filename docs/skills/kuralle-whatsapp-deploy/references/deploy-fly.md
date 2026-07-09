# Deploy a WhatsApp bot on Fly.io (Node/Bun server)

This is the framework's paved path: a plain Hono server using `createMessagingRouter`. It's the simplest mental model — one process, one webhook route — and it's the same code that runs on any Node 18+/Bun host. The canonical reference lives in the repo at `packages/messaging-meta/examples/whatsapp-server/`; read it, it's deployable as-is.

> **Fly = spike test, not production HA.** Keep it to one small auto-stopping machine. Never provision Fly Managed Postgres — if you need durable state, point the session store at an external Redis/Postgres you own.

## The wiring (from the whatsapp-server example)

```ts
import { Hono } from 'hono';
import { createRuntime, MemoryStore } from '@kuralle-agents/core';
import { createMessagingRouter } from '@kuralle-agents/messaging';
import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import { engagement, whatsappPolicy, webPolicy,
         sessionConsentStore, sessionOwnershipStore } from '@kuralle-agents/engagement';

const whatsapp = createWhatsAppClient({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  appSecret: process.env.WHATSAPP_APP_SECRET!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
});

const runtime = createRuntime({
  agents: [yourAgent],            // ← your defineAgent, unchanged
  defaultAgentId: yourAgent.id,
  sessionStore: new MemoryStore(),// ← swap for Redis/Postgres for durability (see below)
});

const store = runtime.getSessionStore();
const windowStore = /* InMemoryWindowStore() or createRedisWindowStore() */;
const eng = engagement({
  policies: [ whatsappPolicy({ client: whatsapp, windowStore, wabaId: process.env.WHATSAPP_WABA_ID! }), webPolicy() ],
  consent: sessionConsentStore(store, { defaultOptedIn: true }),
  ownership: sessionOwnershipStore(store),
  windowStore,
});

const app = new Hono();
app.route('/messaging', createMessagingRouter({
  runtime,
  platforms: { whatsapp },
  ...eng.bridge,
}));
app.get('/health', (c) => c.json({ status: 'ok' }));

// serve — Bun.serve(app.fetch) under Bun, @hono/node-server under Node.
```

`createMessagingRouter` does the heavy lifting: GET verification, HMAC check, normalization, **inbound media download → `file` part**, running the turn, and sending the reply (text + interactive) window-safely via the engagement policies. You don't hand-roll any of it.

## Durability on Fly

`MemoryStore` loses everything on restart, and a spike-test machine **will** restart/stop. If your bot has a suspend/resume step (or you just want cart/history to survive), set `REDIS_URL` and use a Redis-backed session + window store. The run state + effect log ride inside the Session, so a durable SessionStore is all suspend/resume needs.

## fly.toml (spike-test defaults — do not deviate without asking)

```toml
app = "my-whatsapp-bot"
primary_region = "iad"

[build]

[http_service]
  internal_port = 3333
  force_https = true
  auto_stop_machines = "stop"     # mandatory
  auto_start_machines = true      # mandatory
  min_machines_running = 0        # mandatory — scales to zero

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"                # raise only on observed OOM
```

Exactly **one** machine. No `[mounts]` to Fly Postgres. If a DB is truly needed, use external Supabase/Neon/Upstash and ask the user first.

## Deploy

```bash
fly launch --no-deploy          # generate the app; then paste the fly.toml above
fly secrets set \
  OPENAI_API_KEY=... \
  WHATSAPP_ACCESS_TOKEN=... WHATSAPP_APP_SECRET=... \
  WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_VERIFY_TOKEN=... WHATSAPP_WABA_ID=...
fly deploy

# webhook will be at: https://<app>.fly.dev/messaging/whatsapp/webhook
```

## Local dev

Run the server and tunnel the webhook with ngrok:

```bash
bun run server.ts        # or: npx tsx server.ts
ngrok http 3333          # point Meta's Callback URL at the https ngrok URL
```
