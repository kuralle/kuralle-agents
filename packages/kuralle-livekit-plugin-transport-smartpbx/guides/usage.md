# SmartPBX Transport Usage Guide

This package provides the SmartPBX-native transport adapter contract for the official AI Provider WebSocket interface. Keep codec conversion policy and any non-protocol metadata delivery in your host app.

## When to use it

- SmartPBX-like WebSocket media event integrations.
- You need to keep transport logic reusable and testable, outside app examples.
- You want explicit control over conversion/resample strategy in the caller app.
- You want to stay within the official SmartPBX AI Provider protocol surface: `start`, `media`, and close.

## Runtime contract

- `SmartPBXTransportAdapter` binds a socket + mutable session state.
- Input turn boundary is finalized locally through `audioInput.endCurrentTurn()`.
- Outbound audio is surfaced via `onAudioFrame(frame, session)` callback.
- Agent text is surfaced via optional `onText(text, session)` callback.
- Playback start and finish callbacks track successful outbound delivery only.

## Code blueprint

```ts
import { SmartPBXTransportAdapter } from '@kuralle/livekit-plugin-transport-smartpbx';
import { KuralleVoiceSession } from '@kuralle/livekit-plugin';

const sessionState = {
  callId: 'call-123',
  accountId: 'acct-01',
  isActive: true,
};

const transport = new SmartPBXTransportAdapter({
  socket: ws,
  session: sessionState,
  sampleRate: 24000,
  onAudioFrame: (frame, session) => {
    // Convert/encode and forward to SmartPBX media envelope.
    sendOutboundMedia(ws, session.callId, frame);
  },
  onText: (text, session) => {
    console.info(`[smartpbx] assistant text (${session.callId}): ${text}`);
  },
});

const voiceSession = new KuralleVoiceSession({ runtime, stt, tts, greeting: 'Hello, how can I help?' });
await voiceSession.start(transport);

// On remote stop/hangup event
transport.audioInput.endCurrentTurn();
await voiceSession.close();
await transport.close();
```

## Production checklist

- Keep session state authoritative and update `isActive` promptly.
- Use VAD or another host-side endpointing strategy; the official SmartPBX protocol does not define an `end_of_audio` control event.
- Bound audio callback queue size and detect backpressure.
- Test close/restart behavior under reconnects.
- Keep any application metadata channel separate from the SmartPBX protocol unless SmartPBX publishes an official extension.
