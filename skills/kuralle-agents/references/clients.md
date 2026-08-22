# Clients: web UIs, streaming, and widgets

No guide owns this topic yet. The endpoint set and the streaming contract live in
[deployment](https://agents.kuralle.com/guides/deployment), uploads in
[multimodal](https://agents.kuralle.com/guides/multimodal), and the widget in the
`@kuralle-agents/widget` README. This page collects what a client author needs.

## The wire is the AI SDK's, not a Kuralle one

Since 0.5.0 the default response is a native AI SDK `UIMessageStream`. A React
client uses `useChat` with no bridge code — do not write a `StreamPart` →
`UIMessageChunk` adapter, and delete one if you find it.

```tsx
'use client';
import { useChat } from '@ai-sdk/react';
import type { KuralleUIMessage } from '@kuralle-agents/core';

const { messages, sendMessage } = useChat<KuralleUIMessage>({ api: '/api/chat/sse' });
```

Type the hook with `KuralleUIMessage`. Without it the `data-kuralle-*` parts are
untyped and the compiler cannot tell you which ones exist.

## Endpoints

`createKuralleChatRouter` from `@kuralle-agents/hono-server` mounts:

| Method | Path | Returns |
|---|---|---|
| `POST` | `/api/chat` | Single-turn JSON |
| `POST` | `/api/chat/sse` | AI SDK `UIMessageStream` — the `useChat` default |
| `POST` | `/api/chat/stream` | Chunked text |
| `GET` | `/agents/chat/:sessionId` | WebSocket, widget endpoint |
| `GET` | `/ws/:sessionId` | WebSocket, turn endpoint |
| `GET` | `/api/session/:id` | Fetch session |
| `DELETE` | `/api/session/:id` | Delete session |
| `GET` | `/health` | Health check |

A deployment serves threads at
`POST /v1/agents/:agentEntityId/threads/:threadId/messages`, the same wire:

```ts
const transport = new DefaultChatTransport({
  api: `/v1/agents/${agentId}/threads/${threadId}/messages`,
  headers: () => ({ authorization: `Bearer ${token}`, 'idempotency-key': key.current }),
});
const { messages, sendMessage } = useChat<KuralleUIMessage>({ id: threadId, transport });
```

Append `?format=raw` on any of these for named-event `StreamPart` JSON-SSE. That
form is for non-browser consumers — CLIs, webhooks, custom transports. Use
`createKuralleSseChatRouter` for a router that always emits raw JSON-SSE.

Without the router, pipe a `TurnHandle` directly:

```typescript
app.post('/chat', async (c) => {
  const { input, sessionId } = await c.req.json();
  const handle = runtime.run({ input, sessionId });
  return handle.toUIMessageStreamResponse({ sessionId });
});
```

## Transient and persistent parts are read differently

This is the mistake that produces a panel rendering nothing. Kuralle
orchestration events arrive as typed `data-kuralle-*` parts, and they do not all
reach message history.

| Part | Where to read it |
|---|---|
| `data-kuralle-node`, `-flow`, `-control`, `-flow-*` | **Transient.** `useChat({ onData })` only. Dropped from `message.parts`. |
| `data-kuralle-interactive`, `-safety`, `-handoff`, `-outcome` | **Persistent.** Stays in `message.parts`. |

Transient parts are written with `transient: true`. Reading flow telemetry off
`message.parts` compiles, runs, and shows an empty panel forever.

```tsx
useChat<KuralleUIMessage>({
  api: '/api/chat/sse',
  onData: (part) => {
    if (part.type === 'data-kuralle-flow') setFlowState(part.data);
  },
});
```

## Uploads

Send the shape `useChat` already produces — a text part plus one `file` part per
attachment. `createKuralleChatRouter` maps inbound `UIMessage` parts to
`UserInputContent` for you: text-only collapses to a plain string, file parts
become `FilePart`s pointing at the upload URL.

```tsx
sendMessage({
  role: 'user',
  parts: [
    { type: 'text', text: 'Read this prescription' },
    { type: 'file', url: blobUrl, mediaType: 'image/png', filename: 'rx.png' },
  ],
});
```

Upload the file wherever you like — Vercel Blob, S3, R2 — and pass its URL. No
bridge, no custom parsing. See
[multimodal](https://agents.kuralle.com/guides/multimodal).

## Streaming through a proxy

The runtime sets `Cache-Control: no-cache, no-transform`,
`Content-Encoding: identity`, and `X-Accel-Buffering: no` on every streamed turn.
Leave them alone. They are what stops an intermediary buffering the whole turn
and delivering it in one frame.

Know this failure by sight, because it looks like a slow model rather than a
broken proxy: the server streams correctly, the client spins for the whole turn,
then everything appears at once. A Next.js `rewrites()` proxy in front of the
server is the common cause.

It is also easy to mis-diagnose. Plain `curl` sends no `Accept-Encoding`, so it
measures a healthy stream while a browser — which always negotiates encoding —
sees nothing until the end. Check with `curl --compressed`, or measure in the
browser.

## Session continuity

Save `payload.sessionId` from the `done` event and pass it back on the next turn.
The runtime assigns one on the first turn and persists history against it. The
default `MemoryStore` is in-process; swap it for Redis or Postgres before a
second replica exists. See
[sessions](https://agents.kuralle.com/guides/sessions).

## Embeddable widget

`@kuralle-agents/widget` registers a `<kuralle-widget>` custom element backed by
Preact. It resolves agent config over HTTP, opens a WebSocket, and renders a
floating chat UI with streaming, message queuing, and auto-reconnect.

```html
<kuralle-widget
  agent-url="https://your-api.example.com"
  agent-id="support"
  position="bottom-right"
  theme="light">
</kuralle-widget>
```

The widget calls `GET /api/agent/:agentId` on `agent-url` to resolve the
WebSocket URL, then connects directly to the agent. `WidgetClient` is the
programmatic form — `initWidget()`, `onMessages()`, `onConnectionChange()`,
`sendMessage()`, `dispose()`.

## Starting from a template

`npm create kuralle-agents@latest my-app --template nextjs-chatbot` scaffolds a
Next.js chat app with streaming UI, thread history, and a Kuralle `SessionStore`
that uses Postgres when `POSTGRES_URL` is set. See
[references/authoring-modes.md](authoring-modes.md).

## Letting end users build agents

Different task, different guide: a form that produces agent definitions at
runtime is
[agent-builder-react](https://agents.kuralle.com/guides/agent-builder-react),
covering the builder API, compare-and-swap, and a `useChat` preview pane with
sticky thread pinning. This page is about clients that talk to an agent you
already defined.
