# @kuralle-agents/livekit-plugin-transport-ws

WebSocket transport server and adapter for Kuralle voice sessions.

## Install

```bash
npm install @kuralle-agents/livekit-plugin-transport-ws
```

Peer dependency:

```bash
npm install @kuralle-agents/livekit-plugin
```

## What it does

Provides a WebSocket-based transport layer that browser and server clients connect to for real-time voice sessions with Kuralle agents.

- **`WebSocketAgentServer`** — WebSocket server that accepts connections and manages per-session lifecycle; pass it a `createKuralleSession` factory via `onConnection`.
- **`WebSocketTransportAdapter`** — adapts a WebSocket connection to the transport contract expected by `@kuralle-agents/livekit-plugin` sessions.
- **`WebSocketAudioInput`** / **`WebSocketAudioOutput`** / **`WebSocketTextOutput`** — I/O stream implementations for the WebSocket path.
- **`bridgeWebSocketToRealtimeTransport`** / **`bridgeLiveKitSessionToWebSocket`** — bridge utilities for connecting a WebSocket to provider-native realtime transports.
- Protocol types (`ConfigureMessage`, `AgentTextMessage`, `UserTranscriptionMessage`, etc.) and `parseClientMessage` / `serializeServerMessage` for custom WebSocket handling.
- **`createWsNativeAudioTransport`** — factory for native audio transport use cases.

## Usage

```typescript
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';
import { createKuralleSession } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';

const server = new WebSocketAgentServer({ port: 8080 });

server.onConnection(async (transport) => {
  const session = createKuralleSession({
    runtime: myRuntime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Hello, how can I help?',
  });
  await server.startSession(transport, session);
});

await server.listen();
```

## Related

- [`@kuralle-agents/livekit-plugin`](../livekit-plugin) — voice session orchestrator
- [`@kuralle-agents/livekit-plugin-transport-http`](../livekit-plugin-transport-http) — HTTP/SSE transport alternative
- [`@kuralle-agents/voice-protocol`](../voice-protocol) — wire protocol types shared across transports
