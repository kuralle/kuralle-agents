# @kuralle-agents/livekit-plugin-transport-http

HTTP/SSE transport adapter that connects Kuralle voice sessions to browser or server clients over HTTP.

## Install

```bash
npm install @kuralle-agents/livekit-plugin-transport-http
```

Peer dependency:

```bash
npm install @kuralle-agents/livekit-plugin
```

## What it does

Provides an HTTP-based transport layer for Kuralle voice sessions — an alternative to WebSocket when clients can only reach the agent over HTTP.

- **`createAgentHandler`** — builds an HTTP request handler that upgrades to an `HTTPTransportAdapter` and starts a voice session.
- **`HTTPTransportAdapter`** — implements the transport contract expected by `@kuralle-agents/livekit-plugin` sessions, backed by HTTP/SSE.
- **`HTTPAudioInput`** / **`HTTPAudioOutput`** / **`HTTPTextOutput`** — audio and text I/O streams for the HTTP path.
- **`createSSEWriter`** — creates a server-sent-events writer that emits typed events (`AgentTextEvent`, `AgentAudioEvent`, `UserTranscriptionEvent`, etc.) to the client.

## Usage

```typescript
import { createAgentHandler } from '@kuralle-agents/livekit-plugin-transport-http';
import { createKuralleSession } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';

const handler = createAgentHandler({
  createSession: () =>
    createKuralleSession({
      runtime: myRuntime,
      stt: new GeminiLiveSTT(),
      tts: new GeminiLiveTTS(),
    }),
});

// Mount as a route handler in your HTTP framework.
// handler(req, res) — adapts to Node/Bun/Hono/Express depending on your server.
```

## Related

- [`@kuralle-agents/livekit-plugin`](../kuralle-livekit-plugin) — voice session orchestrator
- [`@kuralle-agents/livekit-plugin-transport-ws`](../kuralle-livekit-plugin-transport-ws) — WebSocket transport
