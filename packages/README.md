# Kuralle Packages

The published packages that make up Kuralle — a TypeScript framework for building conversational AI agents with structured flows, routing, and durable tool execution.

New here? Start from a template:

```bash
npm create kuralle-agents@latest my-app
```

Then read the [documentation](../apps/docs) and the [root README](../README.md). Each package's own `README.md` has its install + usage details.

## Core

| Package | Description |
|---------|-------------|
| [`@kuralle-agents/core`](kuralle-core) | Runtime, agents, flows, tools, sessions — the framework core. |
| [`@kuralle-agents/hono-server`](kuralle-hono-server) | Hono router to host `createRuntime()` over HTTP, SSE, and WebSocket. |
| [`@kuralle-agents/cf-agent`](kuralle-cf-agent) | Cloudflare Workers / Durable Objects integration. |

## Tools & RAG

| Package | Description |
|---------|-------------|
| [`@kuralle-agents/tools`](kuralle-tools) | CAG tools (retrieve + answer) for grounded responses. |
| [`@kuralle-agents/rag`](kuralle-rag) | RAG primitives — knowledge sources, chunkers, retrievers. |
| [`@kuralle-agents/rag-loaders`](kuralle-rag-loaders) | Document loaders for RAG pipelines (ingestion-time only). |

## Session & vector stores

| Package | Description |
|---------|-------------|
| [`@kuralle-agents/redis-store`](kuralle-redis-store) | Redis-backed `SessionStore` (also supports Upstash). |
| [`@kuralle-agents/postgres-store`](kuralle-postgres-store) | PostgreSQL-backed `SessionStore`. |
| [`@kuralle-agents/upstash-store`](kuralle-upstash-store) | Upstash Vector `VectorStore` (edge/serverless). |
| [`@kuralle-agents/lancedb-store`](kuralle-lancedb-store) | LanceDB `VectorStore` (Node/Bun). |
| [`@kuralle-agents/vectorize-store`](kuralle-vectorize-store) | Cloudflare Vectorize `VectorStore` (Workers). |

## Voice

| Package | Description |
|---------|-------------|
| [`@kuralle-agents/realtime-audio`](kuralle-realtime-audio) | Provider-native speech-to-speech (Gemini, OpenAI, xAI) with Kuralle keeping tool/flow/handoff authority. |
| [`@kuralle-agents/voice-protocol`](kuralle-voice-protocol) | Canonical client/server wire protocol for voice transports (types + optional Zod). |

> **Cascaded voice (STT→LLM→TTS) + telephony transports** (`livekit-plugin`, `livekit-plugin-transport-{ws,http,sip,twilio,smartpbx}`, `transport-base`) now live in **[kuralle/kuralle-livekit](https://github.com/kuralle/kuralle-livekit)**, versioned independently while Kuralle hardens text-first.

## Messaging

| Package | Description |
|---------|-------------|
| [`@kuralle-agents/messaging`](kuralle-messaging) | Messaging-platform interfaces and the Kuralle adapter. |
| [`@kuralle-agents/messaging-meta`](kuralle-messaging-meta) | Meta platform clients — WhatsApp, Messenger, Instagram. |
| [`@kuralle-agents/widget`](kuralle-widget) | Embeddable chat widget. |

## Tooling & SDKs

| Package | Description |
|---------|-------------|
| [`create-kuralle-agents`](create-kuralle-agents) | Project scaffolder — `npm create kuralle-agents@latest`. |
| [`@kuralle-agents/eval`](kuralle-eval) | Deterministic conversation replay + assertions for transcripts. |
| [`@kuralle-agents/analytics-sdk`](kuralle-analytics-sdk) | Type-safe SDK for sending analytics events. |
| [`@kuralle-agents/http-client`](kuralle-http-client) | Generic HTTP client — retry, rate limiting, error classification. |

---

All `@kuralle-agents/*` packages version together and publish via `pnpm release`. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the dev/build/publish workflow.

## Resources

- [Documentation](../apps/docs)
- [GitHub](https://github.com/kuralle/kuralle-agents)

## License

MIT
