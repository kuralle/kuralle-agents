# @kuralle-agents/hono-server

Hono router that exposes a Kuralle `Runtime` over HTTP, SSE, and WebSocket.

## Install

```bash
npm install @kuralle-agents/hono-server @kuralle-agents/core ai
```

Peers: `@kuralle-agents/core`, `ai@^6`.

## What it does

`createKuralleChatRouter` mounts a complete set of endpoints onto a Hono app — HTTP chat, SSE streaming, WebSocket widget, session management, audit, CSAT, and a manual compression trigger — wired to any `RuntimeLike` instance.

**As of 0.5.0, `POST /api/chat/sse` defaults to an AI SDK `UIMessageStream`** — a `useChat` client works with zero bridge code. Raw `HarnessStreamPart` JSON-SSE is opt-in via `?format=raw`.

**Key exports:**

- **`createKuralleChatRouter`** — full router: chat, SSE (native default), WebSocket, session, outcome, audit endpoints.
- **`createKuralleSseChatRouter`** — raw JSON-SSE only (explicit legacy wire).
- **`createOpenAICompatRouter`** — OpenAI-compatible `/v1/chat/completions` endpoint.
- **`createKuralleRouter`** — standalone router for flow-manager instances.
- **`shouldEmit` / `sanitizeForClient`** — stream event filter utilities.

## Web client (`useChat`, no bridge)

```tsx
'use client';

import { useChat } from '@ai-sdk/react';
import type { KuralleUIMessage } from '@kuralle-agents/core';

export function Chat() {
  const { messages, sendMessage } = useChat<KuralleUIMessage>({
    api: '/api/chat/sse',
    onData: (part) => {
      // transient telemetry (node/flow/control) — not persisted to message.parts
      if (part.type === 'data-kuralle-node') {
        console.log('node:', part.data);
      }
    },
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          {m.parts.map((part, i) => {
            if (part.type === 'text') return <span key={i}>{part.text}</span>;
            if (part.type === 'data-kuralle-safety') {
              return <div key={i}>Blocked: {part.data.userFacingMessage}</div>;
            }
            if (part.type === 'data-kuralle-interactive') {
              return (
                <div key={i}>
                  {part.data.options.map((o) => (
                    <button key={o.value} onClick={() => sendMessage({ text: o.value })}>
                      {o.label}
                    </button>
                  ))}
                </div>
              );
            }
            return null;
          })}
        </div>
      ))}
    </div>
  );
}
```

Server:

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

`POST /api/chat/sse` accepts `useChat`-shaped bodies (`{ messages: UIMessage[] }`) and returns a native `UIMessageStream`. No `HarnessStreamPart` → `UIMessageChunk` bridge required.

## Raw JSON-SSE (`?format=raw`)

Non-UI consumers (curl, Studio, custom transports) that parsed raw `HarnessStreamPart` JSON from 0.4.x should append `?format=raw`:

```bash
curl -N -X POST 'http://localhost:3000/api/chat/sse?format=raw' \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello","sessionId":"demo"}'
```

Or use `createKuralleSseChatRouter` for a router that always emits raw JSON-SSE on `/api/chat/sse`.

## Endpoints (`createKuralleChatRouter`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | Single-turn JSON response |
| `POST` | `/api/chat/sse` | **Default:** AI SDK `UIMessageStream` (`useChat`). **`?format=raw`:** legacy `HarnessStreamPart` JSON-SSE |
| `POST` | `/api/chat/stream` | Chunked plain-text stream |
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

Applies to raw JSON-SSE (`?format=raw`) and WebSocket paths. The native `UIMessageStream` default passes through the adapter unfiltered.

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — runtime, `harnessToUIMessageStream`, `KuralleUIMessage`.
- [`@kuralle-agents/cf-agent`](https://www.npmjs.com/package/@kuralle-agents/cf-agent) — Cloudflare Workers variant.
- `docs/adr/0005-ai-sdk-native-uimessage-default.md` — decision record and `data-kuralle-*` mapping table.
