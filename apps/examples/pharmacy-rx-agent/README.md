# Kuralle Pharmacy Workspace Agent

A production-shaped reference agent that uses one Kuralle definition across Node.js and Cloudflare. The live Next.js application is a thin hosted client; all conversation, cart, orchestration, and writable workspace state lives in one Cloudflare Durable Object per session.

- Web: <https://pharmacy-rx-agent.vercel.app>
- Cloudflare API: <https://kuralle-pharmacy-workspace-agent.mithushancj.workers.dev>
- Driver: Pi through `@kuralle-agents/pi-driver`
- Durable substrate: Cloudflare `AIChatAgent` + SQLite Durable Object
- Workspace: read-only `/knowledge` plus durable writable `/notes`
- Skills: separate filesystem-backed packages, progressively disclosed with `load_skill` and `read_skill_resource`

This is commerce and framework demonstration code. It does not diagnose, prescribe, recommend treatment, or dispense medicine.

## Architecture

```text
browser / kuralle CLI
        |
        | HTTP JSON through Vercel, or native Agents WebSocket
        v
Cloudflare Worker router
        |
        | session name -> one PharmacyAgent Durable Object
        v
Kuralle Runtime + Pi driver
        |
        +-- Durable conversation, cart, orchestration, traces
        +-- Composite workspace
        |     +-- /knowledge -> immutable bundled files
        |     `-- /notes     -> Durable Object SQLite filesystem
        `-- Skill store (outside workspace traversal)
              +-- prescription-intake
              `-- order-fulfilment
```

The boundary is intentional. The model can traverse both workspace mounts and may mutate `/notes`, but the filesystem rejects every mutation under `/knowledge`. Skill packages are not mounted into the general workspace: the catalog exposes only names and descriptions, `load_skill` returns the matching procedure, and a procedure links to any resource that should be fetched at the third disclosure level.

## Run and test

From the repository root:

```bash
bun install
bun run --cwd packages/core build
bun run --cwd packages/fs build
bun run --cwd packages/cf-agent build

cd apps/examples/pharmacy-rx-agent
bun run test
bun run typecheck
bun run build
bun run test:cloudflare
bun run cf:check
```

The Cloudflare tests run in workerd, not Bun. They verify the Worker route plus SQLite filesystem persistence and isolation between Durable Object instances.

For the direct Node host, call `createNodePharmacyRuntime()` from `node/runtime.ts`. Give it a caller-owned session store and durable workspace directory in a long-lived Node service. The Vercel route deliberately proxies Cloudflare instead: a serverless function's local disk is not the authoritative durable workspace.

## Hosted protocols and CLI

Completion-oriented HTTP clients use:

```http
POST /api/chat
content-type: application/json

{"sessionId":"customer-42","message":"What is in my cart?"}
```

Native Cloudflare clients use `/agents/pharmacy-agent/{sessionId}` over WebSocket.

```bash
# Save the Next.js facade as the default hosted runtime
kuralle connect https://pharmacy-rx-agent.vercel.app --transport http
kuralle chat --session customer-42

# Or connect directly with Cloudflare's native Agents protocol
kuralle connect https://kuralle-pharmacy-workspace-agent.mithushancj.workers.dev \
  --transport cloudflare --agent-name pharmacy-agent
kuralle chat --session customer-42 \
  --auto "check cetirizine 10 mg|what did I ask about?"

kuralle connection
kuralle disconnect
```

Saved connections contain only the server, transport, and agent name. Supply authentication at runtime with `KURALLE_TOKEN`; the CLI does not persist tokens.

## Deploy

Cloudflare:

```bash
wrangler secret put OPENAI_API_KEY --config wrangler.jsonc
bun run cf:deploy
```

Vercel must build with the monorepo as its source and `apps/examples/pharmacy-rx-agent` as the project Root Directory. `pnpm-workspace.yaml` includes `apps/examples/*`, and `vercel.json` selects Next.js with a Webpack production build so Vercel's output tracing remains portable across package-manager layouts.

```bash
cd ../../..
vercel link --yes --scope <team> --project pharmacy-rx-agent
vercel deploy --prod --archive=tgz --scope <team>
```

The Next.js server needs no model secret. It talks to the Cloudflare Worker through `CLOUDFLARE_AGENT_URL`, which defaults to the deployed example URL.

## Production hardening

This public example intentionally has permissive CORS and no tenant authentication. A real pharmacy deployment must authenticate both HTTP and WebSocket routes, map authorized tenant/user identities to server-owned session names, restrict retention and deletion, avoid unnecessary health data, audit tool calls, and apply an explicit approval policy to consequential operations. A session name is a routing key, not authorization.
