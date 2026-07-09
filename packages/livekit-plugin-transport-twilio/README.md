# @kuralle-agents/livekit-plugin-transport-twilio

Twilio Media Streams transport adapter that connects Kuralle voice sessions to inbound phone calls via Twilio.

## Install

```bash
npm install @kuralle-agents/livekit-plugin-transport-twilio @kuralle-agents/livekit-plugin
```

## What it does

Speaks Twilio's Media Streams WebSocket protocol (G.711 mu-law, 8 kHz) and handles automatic resampling to the 24 kHz PCM format Kuralle sessions expect.

- **`TwilioAgentServer`** — WebSocket server that accepts Twilio Media Streams connections and manages per-call session lifecycle.
- **`TwilioTransportAdapter`** — transport adapter implementing the `@kuralle-agents/livekit-plugin` transport contract; processes Twilio's `connected`, `start`, `media`, and `stop` events.
- **`TwilioAudioInput`** / **`TwilioAudioOutput`** / **`TwilioTextOutput`** — audio and text I/O for the Twilio path.
- **`mulawEncodeArray`** / **`mulawDecodeArray`** — G.711 mu-law codec utilities.
- **`createTwilioNativeAudioTransport`** — factory for provider-native realtime sessions.

Audio conversion: Twilio sends G.711 mu-law at 8 kHz; the adapter decodes and resamples to 24 kHz for the Kuralle pipeline, and reverses on outbound.

## Usage

```typescript
import { TwilioAgentServer } from '@kuralle-agents/livekit-plugin-transport-twilio';
import { createKuralleSession } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';

const server = new TwilioAgentServer({ port: 8080 });

server.onCall(async (callId, transport) => {
  const session = createKuralleSession({
    runtime: myRuntime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
  });
  await server.startSession(callId, transport, session);
});

await server.listen();
```

Point Twilio Media Streams at your server with a TwiML `<Stream url="wss://your-host/voice/stream" />`.

## Related

- [`@kuralle-agents/livekit-plugin`](../livekit-plugin) — voice session orchestrator
- [`@kuralle-agents/livekit-plugin-transport-sip`](../livekit-plugin-transport-sip) — SIP/RTP alternative
- [`@kuralle-agents/livekit-plugin-transport-ws`](../livekit-plugin-transport-ws) — generic WebSocket transport
