# Package map

Every package publishes as `@kuralle-agents/<name>` and versions in lockstep.
Current version: read the root `package.json` or any package's `package.json` —
do not quote a version from this file.

Install only what the task needs. `core` plus a provider is enough to run an
agent.

## Where each package's docs live

Every package installs a `README.md` you can read at
`node_modules/@kuralle-agents/<pkg>/README.md`. It is the same text npm shows.

Five packages install deeper guides alongside it:

| Package | Installed guides |
|---|---|
| `core` | `guides/` — all 27 framework guides, generated from the docs site to match the installed version. Start at `guides/README.md`. |
| `rag` | `guides/` — `GETTING_STARTED`, `PRIMITIVES`, `KNOWLEDGEFS`, `VECTOR_RETRIEVAL_TOOL` |
| `tools` | `guides/` — `GETTING_STARTED`, `CAG` |
| `postgres-store`, `redis-store` | `guides/VECTOR_STORE.md` |

Read the installed copy before the website. It is version-matched; the site
always describes the latest release.

## Start here

| Package | Reach for it when |
|---|---|
| `core` | Always. Supplies `defineAgent`, `defineTool`, `defineFlow`, `createRuntime`, sessions, skills, policy, memory, tracing. |
| `create-kuralle-agents` | Scaffolding a new project. Run as `npm create kuralle-agents@latest`. |
| `cli` | Driving a running agent from a terminal, or compiling an agent folder. Binary is `kuralle`. |

`core` ships subpath exports — `@kuralle-agents/core/flows`, `/runtime`,
`/session`, `/tools`, `/memory`, `/tracing`, `/guards`, `/prompts`, `/persona`,
`/capabilities`, `/foundation`, `/types`, and matching `/testing` entries. Check
`packages/core/package.json` `exports` before assuming a symbol lives at the
root.

## Hosting the runtime

| Package | Reach for it when |
|---|---|
| `hono-server` | Hosting `createRuntime()` on Node or Bun over HTTP, SSE, and WebSocket. |
| `cf-agent` | Hosting on Cloudflare Workers with Durable Objects. Supplies `KuralleAgent`, SQLite-backed stores, and the DO scheduler. |
| `deployment` | Canonical agent revisions, releases, and thread pins. |
| `build` | Compiling an agent folder into a deterministic artifact. Also `packageSkillsDirectory`, which is workerd-clean. |

## Persistence

| Package | Supplies | Runs on |
|---|---|---|
| `redis-store` | `SessionStore` | Node, Bun, Upstash REST |
| `postgres-store` | `SessionStore` | Node, Bun |
| `lancedb-store` | `VectorStore` | Node, Bun only — not edge |
| `upstash-store` | `VectorStore` | Edge, serverless |
| `vectorize-store` | `VectorStore` | Cloudflare Workers |

The default `SessionStore` is an in-process `MemoryStore` from `core`. Replace it
before a second replica exists.

## Capabilities

| Package | Reach for it when |
|---|---|
| `tools` | You want the prebuilt CAG tools rather than writing your own. |
| `rag` | Building retrieval: chunking, embedding, keyword index, ingest manifest. |
| `rag-loaders` | Loading documents at ingestion time. Never import this at runtime. |
| `fs` | The agent needs a portable filesystem, a workspace, or a shell. |
| `mcp` | The agent calls an MCP server. |
| `plugins` | Loading a third-party Agent Plugin with `loadAgentPlugin`. |
| `commerce` | Carts, idempotent orders, catalog contracts. |
| `http-client` | Calling a REST API with retry, rate limiting, and error classification. |
| `pi-driver` | Swapping the AI SDK model/tool loop for the Pi agent core. |

## Channels

| Package | Reach for it when |
|---|---|
| `messaging` | The channel-agnostic interfaces and the Kuralle adapter. |
| `messaging-meta` | WhatsApp, Messenger, or Instagram through the Meta platform. |
| `engagement` | Window-safe outbound, smart send, interactive fidelity, handoff, consent, and proactive messages across channels. |

## Testing and operations

| Package | Reach for it when |
|---|---|
| `eval` | Deterministic conversation replay and assertions over transcripts. |
| `analytics-sdk` | Sending events to the Kuralle Analytics Platform. |
| `trace-ui` | Embedding a read-only trace viewer. |
| `widget` | Embedding a chat widget. |
| `e2e-tests` | Private. End-to-end coverage for flows, durability, and post-run audit. |

`core` also exports evaluation primitives directly: `EvalRunner`,
`simulateConversation`, `createJudge`, and `runSimulationSuite`. Reach for
`@kuralle-agents/eval` when you need replay against recorded transcripts.

## Peer dependencies

Kuralle does not bundle a model provider. Install `ai` (Vercel AI SDK v7), `zod`,
and the provider package you use — `@ai-sdk/openai`, `@ai-sdk/anthropic`,
`@ai-sdk/google`, or `@ai-sdk/xai`.

Keep `zod` on one major version across the workspace. Mixing zod 3 and zod 4
forks `ai` into duplicate copies and produces `Tool` type mismatches.
