# @kuralle-agents/livekit-plugin-transport-smartpbx

SmartPBX WebSocket media-stream transport adapter for Kuralle voice sessions.

## Install

```bash
npm install @kuralle-agents/livekit-plugin-transport-smartpbx
```

Peer dependency:

```bash
npm install @kuralle-agents/livekit-plugin
```

## What it does

Implements the SmartPBX AI Provider contract (version 2025.10.29) so Kuralle voice sessions can receive and send audio over a SmartPBX WebSocket media stream.

- **`SmartPBXTransportAdapter`** — transport adapter that handles `start` and `media` events from the SmartPBX WebSocket and routes audio to `SmartPBXAudioInput` / `SmartPBXAudioOutput`.
- **`SmartPBXAudioInput`** / **`SmartPBXAudioOutput`** / **`SmartPBXTextOutput`** — I/O stream implementations for the SmartPBX path.
- **`createSmartPbxNativeAudioTransport`** — factory for use with provider-native realtime sessions.
- **`DEFAULT_SMARTPBX_SAMPLE_RATE`** — default 8 kHz sample rate for G.711 SmartPBX streams.

Codec conversion (G.711, Opus, resampling) is composed in the host app via the `onAudioFrame` callback — this package handles only the transport I/O contract and session lifecycle.

## Usage

```typescript
import {
  SmartPBXTransportAdapter,
  SmartPBXAudioInput,
  SmartPBXAudioOutput,
  SmartPBXTextOutput,
} from '@kuralle-agents/livekit-plugin-transport-smartpbx';

// Instantiate per-call when SmartPBX connects.
const transport = new SmartPBXTransportAdapter({
  send: (msg) => ws.send(msg),
  onAudioFrame: (frame) => { /* resampling + forwarding */ },
});

ws.on('message', (data) => transport.handleMessage(data.toString()));
```

## Related

- [`@kuralle-agents/livekit-plugin`](../kuralle-livekit-plugin) — voice session orchestrator
- [`@kuralle-agents/livekit-plugin-transport-sip`](../kuralle-livekit-plugin-transport-sip) — SIP/RTP telephony transport
