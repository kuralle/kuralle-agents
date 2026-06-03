# WhatsApp Server Example (deployable)

Self-host a WhatsApp bot with your own Cloud API number and token — no Embedded Signup. One Kuralle runtime, one support flow, with window-safe outbound via `@kuralle-agents/engagement` policies.

## Architecture

```
WhatsApp user ──>  /messaging/whatsapp/webhook  ──>  engagement({ policies: [whatsapp, web] })
                                                          │
                                                          ▼
                                                   createMessagingRouter
                                                          +
                                                   shared Runtime + flow
```

- **`createWhatsAppClient`** — real Meta Cloud API transport (env-driven credentials)
- **`engagement({ policies })`** — spread **`...eng.bridge`** into `createMessagingRouter`
- **`whatsappPolicy`** — 24h window, template recovery, interactive rendering
- **`webPolicy`** — null adapter for the shared outbound chain (web not exposed in this example)

## Prerequisites

1. A **Meta Developer** app with **WhatsApp Cloud API** and a phone number added
2. A **model API key** (OpenAI, Google, or xAI)
3. **ngrok** (or similar) for local webhook forwarding

## Environment Variables

Required when **running** the server (not for `typecheck:all` or offline tests):

```bash
# WhatsApp Cloud API (bring your own number)
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=          # any secret string you choose for Meta webhook verification
WHATSAPP_WABA_ID=

# Model (one of)
OPENAI_API_KEY=
# GOOGLE_GENERATIVE_AI_API_KEY=
# XAI_API_KEY=

# Optional
PORT=3333
REDIS_URL=redis://127.0.0.1:6379   # durable WindowStore; in-memory when unset
KURALLE_EXAMPLE_PROVIDER=openai    # force openai | google | xai
```

If required vars are missing, the server prints setup instructions and exits **0** (safe for CI/typecheck imports).

## Running locally

```bash
# From repo root
bun install
bun run build

bun run packages/kuralle-messaging-meta/examples/whatsapp-server/server.ts
```

## Webhook setup

Expose your server (ngrok for local dev):

```bash
ngrok http 3333
```

In the Meta Developer dashboard, configure the WhatsApp webhook:

| Field | Value |
|-------|-------|
| Callback URL | `https://<host>/messaging/whatsapp/webhook` |
| Verify token | Same value as `WHATSAPP_VERIFY_TOKEN` |

Subscribe to the `messages` field (and `message_template_status_update` if you use templates).

## Deploy

### Node / Bun (any host)

Run `server.ts` on any VPS, container, or PaaS that supports Node 18+ or Bun:

```bash
bun run packages/kuralle-messaging-meta/examples/whatsapp-server/server.ts
# or: npx tsx packages/kuralle-messaging-meta/examples/whatsapp-server/server.ts
```

Set all env vars in your host's secret manager. Point Meta's webhook at your public URL.

- **Bun:** uses `Bun.serve` when run with Bun
- **Node:** falls back to `@hono/node-server` when `Bun` is unavailable

Set `REDIS_URL` in production for a durable conversation window store across restarts and replicas.

### Cloudflare Workers

For edge/serverless deployment, use `@kuralle-agents/cf-agent` with the same runtime and engagement wiring. Mount `createMessagingRouter` on your Worker's fetch handler at `/messaging`. See the cf-agent package docs for Durable Object session patterns.

## Offline smoke test

```bash
bun test packages/kuralle-messaging-meta/examples/whatsapp-server/whatsapp-server.test.ts
```

Verifies the Hono app mounts the messaging router and responds to Meta webhook verification (GET challenge) without live Meta or model calls.

## Files

| File | Purpose |
|------|---------|
| `server.ts` | Entry point — env guard, client construction, serve |
| `app.ts` | `createWhatsAppServerApp()` — runtime, engagement, router mount |
| `window-store.ts` | `InMemoryWindowStore` or `createRedisWindowStore` when `REDIS_URL` set |
| `resolve-model.ts` | Live model resolver (`KURALLE_EXAMPLE_PROVIDER`) |
| `env.ts` | Missing-env detection and setup instructions |
