# Production customer-support agent

A configurable Kuralle support application with one agent definition and two durable hosts:

- **Vercel:** Next.js UI and Node API, with sessions, approvals, audit entries, and traces in PostgreSQL.
- **Cloudflare:** Worker API and one SQLite-backed Durable Object per authenticated conversation.

Both hosts run the same [Pi-backed agent](src/agent.ts), [knowledge adapter](src/knowledge.ts), [support-system contract](src/backend.ts), guardrails, approval policy, and escalation behavior. Ordinary customer setup happens in [support.config.ts](support.config.ts), not by forking the runtime.

This is a production-shaped template, not a claim that a generic support bot is production-ready without your authentication, policies, support-system adapter, evaluations, and incident process.

## What you get

| Concern | Included boundary |
| --- | --- |
| Identity | signed, HTTP-only server cookie; client conversation IDs are scoped under the authenticated server identity |
| Durability | PostgreSQL on Vercel; single-writer Durable Object SQLite on Cloudflare |
| Knowledge | validated customer corpus, cross-runtime BM25 retrieval, source metadata, automatic pre-injection |
| Actions | fresh account reads; writes are idempotent and pause for explicit approval |
| Human handoff | terminal `human` handoff with a grounded conversation package sent to your support backend |
| Safety | prompt-injection blocking, payment-identifier redaction, moderation, bounded tools, grounded-output validation |
| Operations | structured server errors, Kuralle traces, Cloudflare logs/traces, 30-day Postgres trace retention |
| Portability | one Kuralle agent and Pi driver on both runtime substrates |

The shape follows the useful lesson in [ToyotaGPT](https://www.youtube.com/watch?v=nUNuNxMhwug): keep the reviewed platform stable and make each new agent mostly configuration, knowledge, skills, and authorized tools. It also borrows the good substrate split demonstrated by [camelAI](https://github.com/qaml-ai/camelAI): a Durable Object is a coordination atom, while untrusted execution belongs behind a separate controlled boundary. This support agent does not need a shell or VM, so it exposes neither.

## Five-minute local start

From the repository root:

```bash
cp apps/examples/customer-support-agent/.env.example apps/examples/customer-support-agent/.env.local
docker compose -f apps/examples/customer-support-agent/docker-compose.yml up -d --wait
openssl rand -hex 32
```

Put the generated value in `SUPPORT_IDENTITY_SECRET`, add `OPENAI_API_KEY`, and leave `SUPPORT_DEMO_MODE=true` for local evaluation. Then:

```bash
bun run --cwd apps/examples/customer-support-agent dev
```

Open [http://localhost:3000](http://localhost:3000). The local fixture recognizes order `NS-100042`. Demo mode is rejected when `NODE_ENV=production` or `VERCEL_ENV=production`, so it cannot silently become the live system of record.

## Swap in your company

### 1. Replace brand and knowledge

Edit only [support.config.ts](support.config.ts):

- `brand`: customer-facing company, agent, product, tagline, and accent color;
- `behavior`: voice, scope, and the honest insufficient-evidence response;
- `humanSupport`: published hours and timezone;
- `orderIdPattern`: the identifier accepted before an order-system call;
- `starterPrompts`: the four useful entry points shown in the UI;
- `knowledge`: your reviewed help articles, including source URL and revision date.

The config validates at module load. Empty corpora, malformed IDs, bad URLs, and accidental oversized content fail the build instead of weakening answers at runtime.

For a few hundred compact articles, the built-in BM25 index is a good zero-service starting point. For a large or frequently changing corpus, replace `createSupportKnowledge()` with a Kuralle `KnowledgeRetrieverAdapter` backed by pgvector, Cloudflare Vectorize, or your search service. Do not move knowledge into the model-traversable filesystem: support facts need a retrieval and citation contract, not directory browsing.

### 2. Connect your support systems

The production HTTP adapter expects:

```text
GET  /v1/customers/:customerId/orders/:orderId
POST /v1/cases
POST /v1/escalations
```

Every request carries `Authorization: Bearer <SUPPORT_API_TOKEN>`. Case creation and escalation include an `Idempotency-Key` header. Responses are schema-validated before reaching the model; unexpected fields are not treated as proof.

If your CRM or commerce API differs, implement the three-method `SupportBackend` interface instead of changing agent logic:

```ts
interface SupportBackend {
  lookupOrder(input): Promise<SupportOrder | null>;
  createCase(input): Promise<SupportCase>;
  queueEscalation(request): Promise<EscalationOutcome>;
}
```

Keep authentication and authorization in that adapter. A model tool call is intent, not authority.

### 3. Replace anonymous identity for account operations

The included signed cookie gives every browser a server-owned, isolated identity. It prevents a caller from selecting another conversation, but it does **not** prove a real-world account identity.

Before enabling account data in production, replace `resolveSupportIdentity()` at the HTTP boundary with your existing session or OIDC verification and map its stable subject to `userId`. Preserve these properties:

1. derive identity only from a verified server-side credential;
2. create `sessionId` on the server as `userId + validated conversationId`;
3. bind each Cloudflare Durable Object permanently to one user;
4. attribute approvals to the verified actor, never an ID supplied in JSON;
5. authorize every order or case again in the downstream support API.

## Deploy to Vercel

1. Import this repository and choose `apps/examples/customer-support-agent` as the project Root Directory. Keep **Include source files outside the Root Directory** enabled because the example consumes workspace packages. Vercel documents this monorepo setup in its [monorepo guide](https://vercel.com/docs/monorepos) and [monorepo FAQ](https://vercel.com/docs/monorepos/monorepo-faq).
2. Provision a PostgreSQL integration from the Vercel Marketplace and map its pooled TLS URL to `DATABASE_URL`. Vercel now connects external Postgres providers through Marketplace integrations; its guidance recommends a pooler for serverless connections. See [Postgres on Vercel](https://vercel.com/docs/postgres) and [Marketplace storage](https://vercel.com/docs/marketplace-storage).
3. Configure production environment variables:

```text
OPENAI_API_KEY
OPENAI_MODEL=gpt-4.1-mini
DATABASE_URL
SUPPORT_IDENTITY_SECRET
SUPPORT_API_URL
SUPPORT_API_TOKEN
```

4. Do **not** set `SUPPORT_DEMO_MODE` in Preview or Production.
5. Deploy, then verify `GET /api/health`, one grounded question, one denied approval, one approved case, and one human escalation.

The session and trace stores create their Kuralle tables idempotently. Your support-system database remains separately owned by your application.

## Deploy to Cloudflare

Cloudflare now recommends the declarative `exports` configuration and SQLite for new Durable Object namespaces. The included [wrangler.jsonc](wrangler.jsonc) follows that current shape; see the [Durable Object class lifecycle reference](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) and [Agents configuration guide](https://developers.cloudflare.com/agents/runtime/operations/configuration/).

1. Replace `ALLOWED_ORIGINS` in `wrangler.jsonc` with the exact browser origin. For cross-origin cookies, use a custom API domain under the same site as the UI when possible.
2. Store all secrets with Wrangler:

```bash
cd apps/examples/customer-support-agent
bunx wrangler secret put OPENAI_API_KEY
bunx wrangler secret put SUPPORT_IDENTITY_SECRET
bunx wrangler secret put SUPPORT_API_URL
bunx wrangler secret put SUPPORT_API_TOKEN
```

3. Check the bundle and deploy:

```bash
bun run cf:check
bun run cf:deploy
```

Cloudflare provisions the Worker, Durable Object namespace, and SQLite storage during deployment. `GET /api/health` reports the selected substrate. Tail live logs with `bunx wrangler tail`.

The Worker exposes the JSON API. To use the included Next.js UI, set `NEXT_PUBLIC_SUPPORT_API_URL` to the Worker custom domain on the UI deployment. Keep the UI and API under the same registrable domain or proxy `/api/*` through the UI host; third-party-cookie blocking can otherwise prevent stable browser identity even when CORS is correct.

For local Worker evaluation:

```bash
cp .dev.vars.example .dev.vars
bun run cf:dev
```

Use `ENVIRONMENT=development` only in `.dev.vars`; deployed configuration defaults to production and refuses the demo backend.

## HTTP contract

### Chat

```http
POST /api/chat
Content-Type: application/json
X-Idempotency-Key: <client-message-uuid>

{"conversationId":"support_...","message":"Check order NS-100042"}
```

The response is completion-oriented JSON:

```json
{
  "conversationId": "support_...",
  "response": "…",
  "status": "completed"
}
```

An approval pause returns `status: "approval-required"` plus `pendingApproval.requestId`, title, and description. The Cloudflare bridge preserves this exact durable interrupt descriptor; resuming against a generic chat request ID would be unsafe.

### Approval

```http
POST /api/chat/approval
Content-Type: application/json

{
  "conversationId": "support_...",
  "requestId": "interrupt-...",
  "decision": "approve"
}
```

The server derives the actor from the signed/verified identity. Re-delivery is safe at the durable effect layer, and the backend receives its own stable idempotency key.

## Why these substrates

```text
Browser
  └─ verified HTTP boundary
      ├─ Vercel: Runtime → Postgres session/audit/trace tables
      └─ Cloudflare: Worker → one SupportAgent Durable Object → SQLite
                            └─ same Kuralle agent + Pi driver
                                 ├─ automatic knowledge retrieval
                                 ├─ read-only order tool
                                 ├─ approval-gated case tool
                                 └─ terminal human handoff
```

- **Pi is the model-turn substrate, not the product architecture.** Kuralle owns identity-bearing session state, deterministic policy, durable effects, knowledge, handoff, validation, and traces; Pi owns the model/tool turn loop. That separation lets the same application run on both hosts.
- **A Durable Object is the coordination atom.** One authenticated conversation maps to one object, giving the run journal, messages, approvals, memory, and traces a single writer.
- **Postgres is the serverless shared store.** Vercel functions can be concurrent and ephemeral, so local disk or process memory cannot be authoritative.
- **The support API is the authority boundary.** Neither the model nor the conversation store decides whether a customer owns an order or may receive an exception.
- **No shell is exposed.** A customer-support agent needs knowledge and narrow business operations, not ambient code execution.

## Production gates

Before real traffic, prove all of these in staging:

- a forged or modified identity cookie cannot access another conversation;
- the downstream support API rejects a customer/order ownership mismatch;
- prompt injection does not reveal instructions or bypass a tool gate;
- card/IBAN input is redacted before persisted model history;
- creating a case pauses, denial performs no write, approval writes once, and retry stays once;
- a tool outage produces an honest limitation, not a fabricated result;
- human escalation arrives with the correct customer, summary, recent messages, and queue result;
- retrieval evaluations cover your top contact reasons, synonyms, stale articles, and missing evidence;
- traces and downstream logs share a session/case correlation key without leaking secrets;
- ingress rate limits and load shedding are configured for both anonymous and authenticated traffic;
- retention, deletion, incident response, and human takeover are owned by named teams.

## Verification

```bash
bun run --cwd apps/examples/customer-support-agent typecheck
bun run --cwd apps/examples/customer-support-agent test
bun run --cwd apps/examples/customer-support-agent build
bun run --cwd apps/examples/customer-support-agent cf:check
```

The Cloudflare bridge regression also lives in `packages/cf-agent/vitest/http-approval-workers.test.ts` and proves that completion-oriented HTTP clients receive the durable approval descriptor needed to resume safely.

Run the model-backed simulated-customer gate before deployment:

```bash
bun run --cwd apps/examples/customer-support-agent eval
```

It exercises invoice self-service, verified order lookup, suspected account takeover, and refund uncertainty against the real runtime, then applies a strict LLM judge. This lane uses provider calls and is intentionally separate from the credential-free unit suite.
