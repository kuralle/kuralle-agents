# Voice Transports

All transports implement the `NativeAudioTransport` interface. The agent and runtime code stays identical — swap transport packages to change deployment target.

## Transport packages

| Transport | Package | Wire format | Use case |
|-----------|---------|-------------|----------|
| WebSocket | `@kuralle-agents/livekit-plugin-transport-ws` | Int16 PCM binary | Browser/SDK clients |
| SIP/RTP | `@kuralle-agents/livekit-plugin-transport-sip` | G.711 via RTP | 3CX, FreePBX, Asterisk, SIP trunks |
| Twilio | `@kuralle-agents/livekit-plugin-transport-twilio` | G.711 u-law + base64 JSON | Twilio Voice |
| SmartPBX | `@kuralle-agents/livekit-plugin-transport-smartpbx` | PCM/G.711 + base64 JSON | SmartPBX telephony |
| SIP/WebSocket (JsSIP) | `@kuralle-agents/livekit-plugin-transport-sip-jssip` | WebRTC via JsSIP | Browser SIP clients |
| HTTP/SSE | `@kuralle-agents/livekit-plugin-transport-http` | Audio upload + SSE | HTTP-based voice |

## WebSocketAgentServer

```bash
bun add @kuralle-agents/livekit-plugin-transport-ws
```

```ts
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';

const server = new WebSocketAgentServer({ port: 8080, autoSendSessionStarted: false });

// Native audio (provider-native path)
server.onConnection(async (adapter) => { /* startNativeSession() */ });

// Cascaded pipeline path (use startSession instead)
server.onConnection(async (transport) => { /* KuralleVoiceSession */ });

await server.listen();
await server.close(); // graceful shutdown
```

`autoSendSessionStarted: false` — set this when using `startNativeSession()`. The controller sends `session_started` at the right time.

## SIPAgentServer (telephony)

```bash
bun add @kuralle-agents/livekit-plugin-transport-sip
```

```ts
import { SIPAgentServer } from '@kuralle-agents/livekit-plugin-transport-sip';

const server = new SIPAgentServer({
  localAddress: '0.0.0.0',
  sipPort: 5060,       // Standard SIP port
  rtpPortStart: 10000, // RTP port range start
  codec: 'PCMU',       // G.711 u-law (most compatible)
});

// Native audio path
server.onCall(async (transport, callId) => {
  const binding = await startNativeSession({
    authority: runtime.authority,
    agentId: 'support',
    sessionId: callId,
    modelPolicy: { provider: 'google', preferUpdateAgentForReconfigure: true },
  });

  const session = await server.startRealtimeSession(callId, {
    model,
    agent: binding.agent,
    maxToolSteps: 5,
    onSessionEnd: (reason) => void binding.controller.detach(reason),
    onEvent: (event) => {
      // SIP has no text channel — use onEvent for observability
      if (event.type === 'user_transcription') console.log(`User: ${event.data.text}`);
      if (event.type === 'tool_result') console.log(`Tool: ${event.data.toolName}`);
    },
  });

  binding.controller.attach(session);
});

await server.listen();
```

### Audio codec chain

The SIP PBX sends G.711 u-law (PCMU) or a-law (PCMA) at 8kHz over RTP. `SIPAgentServer` handles the codec negotiation and resamples to the PCM format the native audio model expects (typically 24kHz for Gemini). You do not set `sampleRate` on `SIPAgentServer` — the transport owns this conversion.

```
3CX/FreePBX → G.711 PCMU @ 8kHz (RTP/UDP) → SIPAgentServer → PCM s16le @ 24kHz → Gemini Live
```

What this means in practice:
- Do NOT pre-resample audio before passing it to the SIP server
- If you switch providers (e.g. Gemini → OpenAI), the transport still handles conversion — you only change the `model` reference
- SIP has no text channel — use `onEvent` for transcription logging (see example above)

### Connect a SIP client

**Softphone (Linphone, Zoiper, MicroSIP):**
- Server: your machine IP
- Port: 5060, UDP
- No authentication required

**3CX:** Management Console → Voice & Chat → Add Trunk → Generic SIP Trunk (IP Based) → your IP:5060

**Programmatic (SIPTestClient):** see `references/voice-testing.md`

### OpenAI VAD tuning for SIP

SIP audio has more noise than WebSocket. OpenAI needs lower threshold:

```ts
const model = new openai.realtime.RealtimeModel({
  apiKey: process.env.OPENAI_API_KEY!,
  voice: 'alloy',
  turnDetection: {
    type: 'server_vad',
    threshold: 0.3,           // lower = more sensitive
    silence_duration_ms: 500,
    prefix_padding_ms: 300,
  },
  inputAudioNoiseReduction: { type: 'near_field' },
});
```

## NativeAudioTransport interface

All transport adapters implement this interface. Codec conversion (G.711 ↔ PCM) is handled internally — you always see raw PCM.

```ts
interface NativeAudioTransport {
  sendAudio(data: Uint8Array): void;      // PCM s16le to client
  onAudio(handler: (data: Uint8Array) => void): void; // PCM s16le from client
  onClose(handler: () => void): void;
  close(): void;
}
```

## LiveKit Room (optional)

For LiveKit Cloud infrastructure (WebRTC rooms, recording, TURN, client SDKs), use `KuralleGeminiRealtimeModel` as a LiveKit `RealtimeModel`:

```ts
import { KuralleGeminiRealtimeModel } from '@kuralle-agents/livekit-plugin';

const model = new KuralleGeminiRealtimeModel({
  gemini: { apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY!, model: 'gemini-2.5-flash-native-audio-preview-12-2025' },
  agentId: 'my-agent',
  basePrompt: 'You are a helpful assistant.',
  voice: 'Kore',
  liveKitAdapter: adapter,
});

class VoiceAgent extends Agent { override llm = model; }
const session = new AgentSession();
await session.start({ agent: new VoiceAgent(), room: ctx.room });
```

Use this only when you need LiveKit Cloud/self-hosted rooms. For direct WebSocket/SIP/Twilio, use the `WebSocketAgentServer` or `SIPAgentServer` paths above.
