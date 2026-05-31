# SIP RTP Transport Usage Guide

This package is for RTP telephony (SIP over UDP + RTP media). It is not the WebRTC SIP-over-WebSocket path.

## When to use it

- PBX or SIP trunk integration (3CX/Asterisk-like routing).
- RTP media plane with telephony codecs (PCMU/PCMA).
- You need server-side SIP signaling and deterministic BYE/cleanup behavior.

## Runtime contract

- `SIPAgentServer` owns signaling, call lifecycle, and RTP transport creation.
- Incoming INVITE triggers `onCall` callback with transport + call ID.
- `startSession(callId, voiceSession)` attaches Kuralle session to that call.
- The transport sends `100 Trying` and `180 Ringing`, then emits `200 OK` only after the call bootstrap callback succeeds.
- Pending INVITEs can be unwound by `CANCEL`; established dialogs can be terminated by remote or local `BYE`.

## Code blueprint

```ts
import { SIPAgentServer } from '@kuralle/livekit-plugin-transport-sip';
import { KuralleVoiceSession } from '@kuralle/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle/livekit-plugin/gemini';

const runtime = new Runtime({
  agents: [{ id: 'assistant', name: 'Assistant', model: openai('gpt-4o-mini'), prompt: 'Be concise.' }],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});

const server = new SIPAgentServer({
  localAddress: '0.0.0.0',
  sipPort: 5060,
  rtpPortStart: 10000,
  codec: 'PCMU',
});

server.onCall(async (_transport, callId) => {
  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Thanks for calling. How can I help?',
  });

  await server.startSession(callId, voiceSession);
});

await server.listen();
```

## Production checklist

- Reserve non-overlapping RTP port ranges per deployment shard.
- Validate BYE and shutdown cleanup for all active calls.
- Enable `continuousPacing` when your carrier or SBC expects steady 20ms RTP.
- Add integration tests for INVITE/ACK/BYE/CANCEL fixture flows.
- Keep SIP and media-plane logs correlated by call ID.
- Treat this package as UDP-only today; reject or route TCP/WSS SIP elsewhere.
- Plan a separate hardening track for `re-INVITE`, hold/resume, `PRACK`, `REFER`, SRTP, and RTCP if you need broad carrier interoperability.
