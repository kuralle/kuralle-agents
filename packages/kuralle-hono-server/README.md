# @kuralle-agents/hono-server

Hono router that exposes a Kuralle `Runtime` over HTTP, SSE, and WebSocket.

## Install

```bash
npm install @kuralle-agents/hono-server @kuralle-agents/core
```

Peer: `@kuralle-agents/core`.

## What it does

`createKuralleChatRouter` mounts a complete set of endpoints onto a Hono app — HTTP chat, SSE streaming, WebSocket widget, session management, audit, CSAT, and a manual compression trigger — wired to any `RuntimeLike` instance.

**Key exports:**

- **`createKuralleChatRouter`** — full router: chat, SSE, WebSocket, session, outcome, audit endpoints.
- **`createKuralleSseChatRouter`** — SSE-only variant for simpler setups.
- **`createOpenAICompatRouter`** — OpenAI-compatible `/v1/chat/completions` endpoint.
- **`createKuralleRouter`** — standalone router for flow-manager instances.
- **`shouldEmit` / `sanitizeForClient`** — stream event filter utilities.

## Usage

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { createKuralleChatRouter } from '@kuralle-agents/hono-server';
import { openai } from '@ai-sdk/openai';

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini'),
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support' });

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
app.route('/', createKuralleChatRouter({ runtime, upgradeWebSocket }));

const server = serve({ fetch: app.fetch, port: 3000 });
injectWebSocket(server);
```

**Bun:**

```ts
import { upgradeWebSocket } from 'hono/bun';

app.route('/', createKuralleChatRouter({ runtime, upgradeWebSocket }));
export default app;
```

## Endpoints (createKuralleChatRouter)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | Single-turn JSON response |
| `POST` | `/api/chat/sse` | SSE streaming response |
| `POST` | `/api/chat/stream` | Chunked text stream |
| `GET`  | `/agents/chat/:sessionId` | WebSocket widget endpoint |
| `GET`  | `/ws/:sessionId` | WebSocket turn endpoint |
| `GET`  | `/api/session/:id` | Fetch session |
| `DELETE` | `/api/session/:id` | Delete session |
| `POST` | `/api/sessions/:id/outcome` | Mark conversation outcome |
| `GET`  | `/api/sessions/:id/audit` | Replay audit log |
| `POST` | `/api/sessions/:id/csat` | Record CSAT score (1–5) |
| `POST` | `/api/session/:id/compress` | Trigger manual compaction |
| `GET`  | `/health` | Health check |

## Widget welcome mode

Control first-turn behavior on WebSocket connect:

```ts
createKuralleChatRouter({
  runtime,
  upgradeWebSocket,
  widgetWelcomeMode: 'static',
  widgetWelcomeMessage: "Hello, how can I help you today?",
  widgetWelcomeSuggestions: ['Check order status', 'Request a refund'],
});
```

Modes: `'off'` (no welcome), `'static'` (send message directly), `'model'` (generate via runtime).

## Stream filter

```ts
createKuralleChatRouter({
  runtime,
  streamFilter: 'safe',   // default — user-facing events only
  // streamFilter: 'all', // full stream for dev tooling / Studio
});
```

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — runtime and agent primitives.
- [`@kuralle-agents/cf-agent`](https://www.npmjs.com/package/@kuralle-agents/cf-agent) — Cloudflare Workers variant.
