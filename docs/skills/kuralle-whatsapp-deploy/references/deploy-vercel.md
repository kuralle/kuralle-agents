# Deploy a WhatsApp bot on Vercel

Pick Vercel when the bot lives next to a Next.js app or you already deploy there. It's the same `createMessagingRouter` Hono app as the Fly path — the one real difference is **state**: Vercel functions are stateless and there are no Durable Objects, so you must use an **external durable SessionStore**. Don't use `MemoryStore` here; each invocation may be a fresh isolate and you'll lose the conversation between messages.

## The one thing you must change vs Fly

```ts
// ❌ on Vercel this loses state between every message
sessionStore: new MemoryStore()

// ✅ use a durable store reachable over HTTP from a serverless function
//    - Upstash Redis (REST API — works great on Vercel/edge)
//    - Postgres (Neon/Supabase) via @kuralle-agents/postgres-store
sessionStore: createUpstashSessionStore({ url, token })   // or your Postgres store
```

Because the run state + exactly-once effect log live inside the Session (`session.durableRuns`), a durable SessionStore is exactly what makes suspend/resume and idempotent retries work serverlessly. Same goes for the window store — use a Redis-backed one, not in-memory.

## Expose the Hono app as a Vercel function

Hono runs on Vercel directly. Put the app behind a catch-all route so `/messaging/whatsapp/webhook` resolves:

```ts
// app/messaging/[...route]/route.ts   (Next.js App Router)
import { handle } from 'hono/vercel';
import { app } from '../../../src/wa-app';   // the Hono app from the Fly example

export const runtime = 'nodejs';             // not 'edge' unless your stores are edge-safe
export const GET = handle(app);
export const POST = handle(app);
```

The webhook URL becomes `https://<project>.vercel.app/messaging/whatsapp/webhook`.

> Use `runtime = 'nodejs'` unless every dependency (model SDK, session store) is edge-compatible. The Upstash REST store is edge-safe; node-postgres is not.

## Two serverless caveats to call out

1. **Cold starts + Meta's retry window.** A cold function that runs the model inline can exceed Meta's webhook timeout → duplicate deliveries. Either keep turns fast, or acknowledge the webhook (200) and process via a queue/background function. On Vercel that means a queue (e.g. Upstash QStash) rather than `ctx.waitUntil`.
2. **Out-of-band resume (payment links).** The `/wa-pay` route works the same — it calls `runtime.run({ sessionId, signalDelivery })` against the **shared external store** and sends the confirmation via the WhatsApp client. This only works because the store is external; that's why `MemoryStore` is a non-starter here.

## Deploy

```bash
vercel env add OPENAI_API_KEY
vercel env add WHATSAPP_ACCESS_TOKEN
vercel env add WHATSAPP_APP_SECRET
vercel env add WHATSAPP_PHONE_NUMBER_ID
vercel env add WHATSAPP_VERIFY_TOKEN
vercel env add WHATSAPP_WABA_ID
# plus your store creds, e.g. UPSTASH_REDIS_REST_URL / _TOKEN
vercel deploy --prod
```

Then point Meta's Callback URL at `https://<project>.vercel.app/messaging/whatsapp/webhook`.

## Honesty note

The Cloudflare path in this skill is the one proven end-to-end in this repo. Fly and Vercel ride the framework's documented Node/Bun `createMessagingRouter` path — solid, but verify the store wiring with an offline test (fake WhatsApp client + the real runtime) before trusting a live demo, the same way the CF templates are tested.
