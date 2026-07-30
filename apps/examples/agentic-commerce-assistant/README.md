# Agentic Commerce Assistant

A deployable, retrieval-led shopping assistant built with Kuralle, Samesake,
Porulle, Stripe, PostgreSQL, and Cloudflare. The same agent runs in a Cloudflare
Durable Object or as a Node/Bun HTTP service.

The example is intentionally strict about authority:

- the model can interpret requests and propose tool calls;
- Samesake can retrieve and explain candidate products;
- Porulle alone supplies current price, stock, cart, order, and checkout truth;
- Kuralle owns the tool boundary, durable run, approval, and idempotency journal;
- Stripe alone confirms payment;
- a person must approve the frozen checkout before the order tool can run.

No prompt is used as a substitute for a transaction boundary.

## Architecture from first principles

```text
browser / HTTP client
        |
        v
Kuralle shopping agent ---------------- Cloudflare AI Gateway ---> OpenAI
  |     |          |                           (chat + embeddings)
  |     |          |
  |     |          +-- approval + replay journal
  |     |
  |     +-- Samesake hybrid retrieval ----+
  |                                        |
  +-- cart revalidation + checkout         v
          |                          PostgreSQL + pgvector
          v                                 ^
       Porulle -----------------------------+
          |
          v
       Stripe test mode
```

The Cloudflare deployment adds one Durable Object per shopper session, a
Hyperdrive connection to PostgreSQL, and a Queue feeding a retryable catalog
indexing Workflow. Durable Object SQLite stores conversation-local coordination
state and the approval/effect journal; PostgreSQL stores shared search and
commerce data. Approved checkout stays synchronous with the resumed agent turn:
the Durable Object serializes it and Porulle receives the content key as its
idempotency key.

The Node/Bun deployment keeps the same agent definition and integrations. It
replaces the Durable Object session substrate with Kuralle's PostgreSQL session
store and exposes the same `/api/chat` and `/api/chat/approval` contract through
Hono.

Both runtimes mint a signed, HTTP-only shopper cookie. The browser chooses only
a conversation label; the server namespaces the real session key under the
verified cookie identity. On Cloudflare the Durable Object permanently binds
itself to that identity, and approval decisions are attributed to the same
server-authenticated actor.

### Where Pi fits

`@earendil-works/pi-agent-core` is used through `@kuralle-agents/pi-driver` for
the model/tool turn loop and streaming protocol. It is a good substrate for that
job, but it does not replace Kuralle Core:

1. Pi asks for a typed tool call.
2. Kuralle applies tool policy and records the durable run.
3. A consequential `create_order` call produces an approval interrupt before
   its implementation executes.
4. The Durable Object or PostgreSQL store preserves that interrupt.
5. `/resume` records an attributed decision and continues the same run.
6. The order ledger and Porulle idempotency key prevent duplicate effects.

That division lets Pi evolve independently while preserving Kuralle's policy,
session, trace, suspension, and replay contracts. Replacing Kuralle Core with Pi
Core directly would lose those application-level guarantees.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/agent.ts` | One portable agent and its typed tools |
| `src/search.ts` | Samesake contract, indexing, hybrid retrieval, and constraint trace |
| `src/porulle.ts` | Narrow, authenticated Porulle client |
| `src/gateway.ts` | Pi, AI SDK, and embeddings through Cloudflare AI Gateway |
| `src/identity.ts` | Signed shopper identity and server-owned session namespacing |
| `cloudflare/agent.ts` | Durable Object composition through `@kuralle-agents/cf-agent` |
| `cloudflare/workflows.ts` | Retryable catalog indexing workflow |
| `cloudflare/worker.ts` | Assets, agent routing, admin ingestion, and Queue consumer |
| `node/` | Node/Bun server, PostgreSQL sessions, and order ledger |
| `scripts/bootstrap.ts` | Porulle export to Samesake index |
| `public/index.html` | Shared zero-build browser client |

The companion Porulle origin is
[`apps/agentic-commerce-origin`](https://github.com/asyncdotengineering/porulle/tree/main/apps/agentic-commerce-origin).
It adds narrow agent catalog routes without moving search or agent concerns into
Porulle.

## Prerequisites

- Bun 1.3 or newer
- PostgreSQL with the `vector` extension
- a Cloudflare account and Wrangler authentication for the edge deployment
- a Cloudflare AI Gateway
- a Stripe account in test mode

Clone both repositories and install them independently:

```bash
git clone https://github.com/kuralle/kuralle-agents.git
git clone https://github.com/asyncdotengineering/porulle.git

cd kuralle-agents
bun install

cd ../porulle
bun install
```

Samesake is consumed from its public packages; its schema and retrieval contract
are initialized by the bootstrap command.

## Run locally with PostgreSQL

Create one database shared by Porulle, Samesake, and Kuralle:

```bash
createdb kuralle_agentic_commerce
psql kuralle_agentic_commerce -c 'CREATE EXTENSION IF NOT EXISTS vector'
```

### 1. Start the Porulle commerce origin

In the Porulle repository:

```bash
cd apps/agentic-commerce-origin
cp .env.example .env
```

Set these values in `.env`:

```dotenv
DATABASE_URL=postgresql://localhost:5432/kuralle_agentic_commerce
PUBLIC_URL=http://localhost:4000
STRIPE_SECRET_KEY=your_stripe_test_secret_key
STRIPE_WEBHOOK_SECRET=your_local_or_test_endpoint_signing_secret
PORT=4000
```

Test keys come from your Stripe account's test-mode API key page; they are not
shared global credentials. Keep the secret server-side. The assistant uses
Stripe's test PaymentMethod token `pm_card_visa`, so raw card data never enters
the model or either application.

Create the schema and seed the four-product catalog:

```bash
bun run db:push
bun run seed
bun run start
```

The seed command prints a JSON object containing `storefrontKey`. Treat that
value as a secret; copy it into the assistant environment as
`PORULLE_STOREFRONT_KEY`. Re-running the seed updates products, prices, and
inventory idempotently, but creates a new API key.

### 2. Configure the assistant

In the Kuralle repository:

```bash
cd apps/examples/agentic-commerce-assistant
cp .env.example .env
```

Fill the placeholders:

```dotenv
CLOUDFLARE_API_KEY=your_cloudflare_user_token
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_GATEWAY_ID=your_gateway_id
OPENAI_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
DATABASE_URL=postgresql://localhost:5432/kuralle_agentic_commerce
SAMESAKE_API_KEY=choose-a-local-key-of-at-least-eight-characters
PORULLE_URL=http://localhost:4000
PORULLE_STOREFRONT_KEY=the_key_printed_by_the_porulle_seed
STRIPE_PAYMENT_METHOD_TOKEN=pm_card_visa
COMMERCE_IDENTITY_SECRET=a-random-secret-containing-at-least-32-characters
ENVIRONMENT=development
PORT=8787
```

`wrangler auth token` prints a scoped Cloudflare user token suitable for local
development. Do not commit it. AI Gateway can use its own stored OpenAI provider
credential, so no OpenAI key is needed in this app.

Verify the account-level AI Run route before debugging the agent:

```bash
curl --request POST \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run" \
  --header "Authorization: Bearer $CLOUDFLARE_API_KEY" \
  --header "cf-aig-gateway-id: $CLOUDFLARE_GATEWAY_ID" \
  --header 'Content-Type: application/json' \
  --data '{"model":"openai/gpt-4.1","input":{"messages":[{"role":"user","content":"Reply with gateway-ok"}],"max_tokens":32}}'
```

The application itself uses the provider-native AI Gateway OpenAI endpoint.
That matters because Pi's OpenAI adapter speaks the provider-native streaming
protocol, while the account-level route above is a useful credential and gateway
probe. Embeddings use the same gateway and token.

### 3. Index and run

Keep the Porulle process running, then in the assistant directory:

```bash
bun run bootstrap
bun run node
```

Open `http://localhost:8787`. A useful end-to-end prompt is:

```text
Find a weatherproof daypack under $120, add the best match, show my cart, and check out.
```

The first request retrieves products and revalidates any cart addition. Checkout
returns `approval-required`; approving resumes the same durable run and executes
the frozen order exactly once.

The Node API can also be called directly:

```bash
curl --request POST http://localhost:8787/api/chat \
  --header 'content-type: application/json' \
  --header 'x-idempotency-key: demo-turn-1' \
  --cookie-jar /tmp/kuralle-commerce.cookies \
  --data '{"conversationId":"demo-shopper-1","message":"Find a daypack under $120"}'
```

Keep the returned cookie when sending later turns or an approval. For local
webhook verification, run Stripe CLI in test mode and copy the printed `whsec_…`
value into `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to localhost:4000/api/payments/webhook
```

## Deploy to Cloudflare with Neon

Use a dedicated Neon database or branch, enable `vector`, and run the same
Porulle schema, seed, and Samesake bootstrap against its connection string. Use
`sslmode=verify-full` for direct Node/Bun connections.

Create the Cloudflare resources once:

```bash
bunx wrangler hyperdrive create kuralle-agentic-commerce-db \
  --connection-string='your_neon_connection_string'
bunx wrangler queues create kuralle-commerce-events
bunx wrangler queues create kuralle-commerce-events-dlq
```

Put the returned Hyperdrive ID into both applications' `wrangler.jsonc` files.
Set the public Porulle URL in its `PUBLIC_URL` variable and in the assistant's
`PORULLE_URL` variable. Replace repository-specific example values before
deploying under your account.

Upload secrets interactively; never place them in `wrangler.jsonc`:

```bash
cd porulle/apps/agentic-commerce-origin
bunx wrangler secret put STRIPE_SECRET_KEY
bunx wrangler secret put STRIPE_WEBHOOK_SECRET
bun run worker:deploy

cd ../../../kuralle-agents/apps/examples/agentic-commerce-assistant
bunx wrangler secret put CLOUDFLARE_API_KEY
bunx wrangler secret put SAMESAKE_API_KEY
bunx wrangler secret put PORULLE_STOREFRONT_KEY
bunx wrangler secret put ADMIN_TOKEN
bunx wrangler secret put COMMERCE_IDENTITY_SECRET
bun run cf:deploy
```

The assistant deployment creates the Durable Object and catalog Workflow. The
Queue bindings refer to the two queues created above. Hyperdrive supplies the
runtime database connection without exposing the Neon password to the Worker.

For a production catalog refresh, export the current Porulle catalog and POST
the documents to `/admin/catalog-sync` with `x-admin-token`. The endpoint only
accepts authenticated non-empty batches, the Queue provides buffering and retry,
and `CatalogSyncWorkflow` performs migration, contract application, upsert, and
index build as named durable steps.

Register the Porulle endpoint
`https://your-porulle-origin/api/payments/webhook` in Stripe test mode and store
that endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`. Porulle rejects
unsigned events, deduplicates Stripe event IDs, and confirms the matching order
from verified `payment_intent.succeeded` metadata.

## Authenticated HTTP approval contract

Cloudflare and Node/Bun expose the same public endpoints:

```text
POST /api/chat
POST /api/chat/approval
```

`POST /api/chat` accepts `{ "conversationId": "…", "message": "…" }`. The
response sets a signed, HTTP-only identity cookie. Keep that cookie on every
later chat and approval request; a client-provided conversation ID is never used
as the storage or Durable Object key by itself.

A paused chat response includes:

```json
{
  "status": "approval-required",
  "pendingApproval": {
    "requestId": "...",
    "title": "Approve order?",
    "description": "..."
  }
}
```

Resume with the exact request ID and original conversation ID:

```json
{
  "conversationId": "the-original-conversation-id",
  "requestId": "the-pending-request-id",
  "decision": "approve"
}
```

The server creates the signal ID and actor attribution. The Durable Object
journals the outstanding interrupt, so reconnecting or sending another chat
message cannot silently lose or bypass it. A different or tampered identity
cookie maps to a different session and cannot resume the pending operation;
absent or mismatched approvals return HTTP 409 on both runtimes.

## Verify before deployment

In the Kuralle repository:

```bash
bun run --cwd apps/examples/agentic-commerce-assistant typecheck
bun run --cwd apps/examples/agentic-commerce-assistant test
bun run --cwd apps/examples/agentic-commerce-assistant cf:check
```

In the Porulle repository:

```bash
bun run --cwd packages/core check-types
bun run --cwd packages/adapter-stripe test
bun run --cwd apps/agentic-commerce-origin check-types
bun run --cwd apps/agentic-commerce-origin test
bun run --cwd apps/agentic-commerce-origin worker:check
```

## Production hardening

- Give the Porulle API key only the catalog/cart/order permissions in the
  `agent_storefront` scope; never use an owner key.
- Use real customer-created Stripe PaymentMethod tokens outside test mode.
- Keep `ENVIRONMENT=production` in production; the agent rejects
  `pm_card_visa` there.
- Replace the included signed anonymous identity resolver with your account
  identity provider when orders must attach to known customers. Preserve the
  server-owned session namespacing and approval actor binding.
- Keep the admin catalog route private, rotate its token, and rate-limit it.
- Configure and monitor the included verified Stripe webhook endpoint before
  accepting real orders; never infer payment success from the agent response.
- Set retention, deletion, alerting, and sampling policies for conversation,
  order, queue, workflow, and trace data.
- Preserve Porulle as the server-side price and inventory authority. Search
  indexes are intentionally allowed to be stale because cart and checkout
  revalidate against the origin.

Official references: [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/),
[Durable Objects](https://developers.cloudflare.com/durable-objects/),
[Workflows](https://developers.cloudflare.com/workflows/),
[Queues](https://developers.cloudflare.com/queues/),
[Hyperdrive](https://developers.cloudflare.com/hyperdrive/),
[Neon](https://neon.com/docs/introduction), and
[Stripe testing](https://docs.stripe.com/testing).
