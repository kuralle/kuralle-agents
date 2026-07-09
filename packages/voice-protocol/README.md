# @kuralle-agents/voice-protocol

Canonical client-server wire protocol types for Kuralle voice transports — pure TypeScript, zero runtime.

## Install

```bash
npm install @kuralle-agents/voice-protocol
# zod is only needed if you use the /zod subpath
npm install zod
```

## What it does

Defines the shared wire format that every Kuralle transport (WebSocket, HTTP, SIP, Twilio, SmartPBX, Cloudflare DO) emits, so a single client library can consume all of them unmodified.

These types are a verbatim lift of the protocol from `@cloudflare/voice` (Apache-2.0; see `NOTICE`). Publishing them here makes the wire protocol a formal Kuralle contract with a stable version constant.

- **`VOICE_PROTOCOL_VERSION`** — wire format version (`1`). The server sends this in the initial `welcome` frame; clients detect mismatches.
- **`VoiceClientMessage`** — discriminated union of messages the client sends (`hello`, `start_call`, `end_call`, `start_of_speech`, `end_of_speech`, `interrupt`, `text_message`).
- **`VoiceServerMessage`** — discriminated union of messages the server sends (`welcome`, `status`, `audio_config`, `transcript`, `transcript_delta`, `metrics`, `error`).
- **`VoiceAudioFormat`** — audio format literals (`pcm16`, `mp3`, `wav`, `opus`, `pcm16-base64`, `g711-mulaw`, `g711-alaw`).
- **`VoiceAudioInput`** / **`VoiceTransport`** — interfaces for pluggable audio capture and transport implementations.
- **`VoicePipelineMetrics`** / **`TranscriptMessage`** — structured metric and transcript types for consumers.

## Usage

```typescript
import {
  VOICE_PROTOCOL_VERSION,
  type VoiceClientMessage,
  type VoiceServerMessage,
  type VoiceAudioFormat,
} from '@kuralle-agents/voice-protocol';

// Parse frames from the wire
function handleServerFrame(raw: string) {
  const msg: VoiceServerMessage = JSON.parse(raw);
  if (msg.type === 'welcome') {
    console.assert(msg.protocol_version === VOICE_PROTOCOL_VERSION);
  }
}
```

### Zod subpath

```typescript
import { VoiceClientMessageSchema } from '@kuralle-agents/voice-protocol/zod';

const result = VoiceClientMessageSchema.safeParse(frameFromWire);
if (!result.success) { /* reject malformed frame */ }
```

## Related

- [`@kuralle-agents/livekit-plugin-transport-ws`](../livekit-plugin-transport-ws) — implements this protocol on the WebSocket path
- [`@kuralle-agents/realtime-audio`](../realtime-audio) — provider-native realtime sessions
