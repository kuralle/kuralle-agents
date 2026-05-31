# @kuralle-agents/livekit-plugin-transport-sip

SIP/RTP telephony transport that bridges Kuralle voice sessions to PBX trunks and SIP endpoints over UDP.

## Install

```bash
npm install @kuralle-agents/livekit-plugin-transport-sip
```

Peer dependency:

```bash
npm install @kuralle-agents/livekit-plugin
```

## What it does

Handles the UDP SIP signaling and RTP media layers for PBX/SBC integrations, so Kuralle agents can answer inbound telephone calls.

- **`SIPAgentServer`** — listens for inbound SIP `INVITE`s and starts a voice session per call.
- **`SIPSignaling`** — manages dialog-level SIP: `INVITE`, `ACK`, `BYE`, `CANCEL`, `OPTIONS`, and outbound `200 OK`.
- **`SIPTransportAdapter`** — implements the transport contract for `@kuralle-agents/livekit-plugin` sessions.
- **`RtpSession`** — sends and receives RTP frames; includes `JitterBuffer` for packet reordering.
- **`PCMU` / `PCMA`** — G.711 mu-law and a-law codec constants (re-exported from `@kuralle-agents/transport-base`).
- **`createSipNativeAudioTransport`** — factory for use with provider-native realtime sessions.

Current scope: UDP only. Handles `INVITE`, `ACK`, `BYE`, `CANCEL`, `OPTIONS`, final `200 OK`, and G.711 codec negotiation. `re-INVITE`, hold/resume, `PRACK`, `REFER`, SRTP, and RTCP are not yet implemented — best suited for controlled PBX/SBC deployments.

## Usage

```typescript
import { SIPAgentServer } from '@kuralle-agents/livekit-plugin-transport-sip';
import { createKuralleSession } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';

const server = new SIPAgentServer({ port: 5060 });

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

## Related

- [`@kuralle-agents/livekit-plugin`](../kuralle-livekit-plugin) — voice session orchestrator
- [`@kuralle-agents/livekit-plugin-transport-twilio`](../kuralle-livekit-plugin-transport-twilio) — Twilio Media Streams alternative
