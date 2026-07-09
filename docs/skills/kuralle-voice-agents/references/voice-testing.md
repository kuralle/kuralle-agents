# Voice Agent Testing

Two testing modes: offline (no API keys, <1s) and live (real provider, 20-60s per turn).

## Offline — FakeRealtimeAudioClient (CI-safe)

Replace the real provider model with `FakeRealtimeAudioClient`. Canned responses trigger the real authority pipeline — tools, flows, hooks, and extraction all run.

```ts
import { TestSession } from '@kuralle-agents/e2e-tests/harness';

const session = new TestSession({
  agents: [myAgent],
  defaultAgentId: myAgent.id,
  responses: {
    'hello': { text: 'Hi there! How can I help?' },
    'weather': {
      toolCalls: [{ name: 'check_weather', args: { city: 'Tokyo' } }],
      text: 'It is 22 degrees in Tokyo.',
    },
    'book': {
      toolCalls: [{ name: 'start_booking', args: {} }],
      text: 'What date works?',
    },
  },
});

await session.start();
const result = await session.run('What is the weather in Tokyo?');

// TurnResult fields
result.assistantText;    // "It is 22 degrees in Tokyo."
result.toolCalls;        // [{ name: 'check_weather', args: { city: 'Tokyo' }, result: { ... } }]
result.hooksFired;       // ['onToolCall:check_weather', 'onToolResult:check_weather']
result.configUpdates;    // Number of reconfigures (flow transitions change this)
result.errors;           // []

await session.close();
```

```bash
bun test test/my-agent.test.ts  # <1 second, no API keys
```

## Test flow transitions offline

```ts
const session = new TestSession({
  agents: [flowAgent],
  defaultAgentId: 'receptionist',
  responses: {
    'book': {
      toolCalls: [{ name: 'start_booking', args: {} }],
      text: 'What date works?',
    },
  },
});

await session.start();
const t1 = await session.run('I want to book an appointment');
expect(t1.configUpdates).toBeGreaterThan(0); // Flow transitioned → real Gemini would reconfigure
expect(t1.hooksFired).toContain('onToolCall:start_booking');
```

`configUpdates` counts how many times the authority would reconfigure the model client. Positive means a flow transition happened.

## Live tests — real audio over WebSocket

For end-to-end validation with real audio through the provider. Requires `GOOGLE_GENERATIVE_AI_API_KEY`.

```ts
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';
import { WsTestClient } from '@kuralle-agents/e2e-tests/harness/ws_client';
import { TraceCollector } from '@kuralle-agents/e2e-tests/harness/trace_collector';
import { getOrGenerateFixture, generateSilence } from '@kuralle-agents/e2e-tests/harness/audio_fixtures';

// Start your server (see native-audio-pipeline.md)
const trace = new TraceCollector();
const client = new WsTestClient({ url: `ws://127.0.0.1:${PORT}`, trace });

await client.waitForOpen();
await client.waitForJsonMessage('session_started', 10000);
await sleep(5000); // Wait for Gemini connection

// CRITICAL: send audio paced at real-time speed
// 960 bytes per frame = 20ms at 24kHz int16 mono
const pcm = await getOrGenerateFixture('Hello, how are you?', 'test_hello.pcm');
await client.sendAudioFramesPaced(new Uint8Array(pcm), 960, 20);
await client.sendAudioFramesPaced(generateSilence(1000), 960, 20); // silence to trigger VAD

await sleep(20000); // wait for response
expect(trace.binaryChunks.length).toBeGreaterThan(0); // audio came back
```

Each live turn takes 20-30 seconds. Run with:
```bash
npx tsx packages/e2e-tests/tests/agentsession-realtime-authority-gemini-e2e.ts
```

## Audio fixture pacing — critical detail

**Static audio dumps don't trigger Gemini's VAD.** Always pace audio at real-time speed:

```ts
// Correct: paced at 20ms intervals
await client.sendAudioFramesPaced(audioData, 960, 20);
// 960 bytes = 480 samples = 20ms at 24kHz int16 mono

// Wrong: dump everything at once — VAD never fires
client.send(audioData); // don't do this
```

## SIP offline test (SIPTestClient)

Test SIP without a real softphone:

```ts
import { SIPTestClient } from '@kuralle-agents/livekit-plugin-transport-sip/test/sip_test_client';

const client = new SIPTestClient({ codec: 'PCMU' });
await client.call('127.0.0.1', 5060);
await client.sendSilence(2000);  // 2s silence to trigger agent greeting
const audio = await client.waitForAudio(10000);
console.log(`Received ${audio.length} samples from agent`);
await client.hangup();
client.close();
```

Run offline SIP E2E tests (no API keys):
```bash
bun test packages/e2e-tests/tests/sip-voice-agent-e2e.test.ts
```

Run live SIP tests:
```bash
# Gemini
bun run packages/e2e-tests/tests/sip-realtime-authority-e2e.ts

# OpenAI
PROVIDER=openai bun run packages/e2e-tests/tests/sip-realtime-authority-e2e.ts

# xAI
PROVIDER=xai bun run packages/e2e-tests/tests/sip-realtime-authority-e2e.ts
```

## Existing E2E test catalog

| Script | What it tests | Keys needed |
|--------|---------------|-------------|
| `fake-client.test.ts` | Real authority + canned responses | None |
| `fake-client-flows.test.ts` | Flow + triage via fake client | None |
| `agentsession-realtime-authority-gemini-e2e.ts` | Full Gemini Live round-trip | GOOGLE_GENERATIVE_AI_API_KEY |
| `agentsession-realtime-authority-openai-e2e.ts` | Full OpenAI round-trip | OPENAI_API_KEY |
| `agentsession-realtime-authority-xai-e2e.ts` | Full xAI round-trip | XAI_API_KEY |
| `agentsession-realtime-authority-flow-e2e.ts` | Flow transitions via Gemini | GOOGLE_GENERATIVE_AI_API_KEY |
| `sip-voice-agent-e2e.test.ts` | SIP offline E2E | None |
