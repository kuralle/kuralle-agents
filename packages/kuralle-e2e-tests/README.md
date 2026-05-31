# @kuralle-agents/e2e-tests

End-to-end tests for Kuralle voice and realtime pipelines. Tests run against real APIs (Gemini Live, OpenAI) or offline with the fake client harness.

## Quick Start

All tests run with `npx tsx`:

```bash
# Offline tests (no API keys, <5 seconds)
bun test packages/kuralle-e2e-tests/tests/fake-client.test.ts

# Single-turn real Gemini E2E (needs GOOGLE_GENERATIVE_AI_API_KEY)
npx tsx packages/kuralle-e2e-tests/tests/livekit-model-ws-bridge.ts

# 3-path benchmark (needs GOOGLE_GENERATIVE_AI_API_KEY)
npx tsx packages/kuralle-e2e-tests/tests/head-to-head-benchmark.ts

# Provider-native voice E2E (see @kuralle-agents/realtime-audio test suite)
# Live API scripts below need GOOGLE_GENERATIVE_AI_API_KEY
```

## Prerequisites

Set API keys in the repo root `.env`:

```
GOOGLE_GENERATIVE_AI_API_KEY=your-gemini-key
```

The cascaded benchmark path also needs `OPENAI_API_KEY` if using OpenAI as the text LLM (or uses Gemini Flash by default).

Tests that need API keys skip gracefully when keys are missing — they print `SKIP` and exit 0.

## Rebuild Before Testing

The E2E tests import from compiled `dist/` of workspace packages. After editing source in `packages/kuralle-livekit-plugin/src/` or `packages/kuralle-core/src/`, rebuild before running E2E tests:

```bash
bun run build          # rebuild all
# or
cd packages/kuralle-livekit-plugin && npm run build   # rebuild one
```

Stale dist is the most common cause of "the fix doesn't work" false negatives.

## Test Categories

### Offline (no API keys)

| Test | What it validates | Run |
|------|-------------------|-----|
| `fake-client.test.ts` | FakeRealtimeAudioClient event emission, response matching, tool call lifecycle | `bun test tests/fake-client.test.ts` |

### Real API (needs Google key)

| Test | What it validates | Time | Run |
|------|-------------------|------|-----|
| `livekit-gemini-realtime.ts` | Model API contract + WS transport → Gemini Live (1 turn) | ~40s | `npx tsx tests/livekit-gemini-realtime.ts` |
| `livekit-model-ws-bridge.ts` | pushAudio → Gemini → audioStream → WS (1 turn, full round-trip) | ~40s | `npx tsx tests/livekit-model-ws-bridge.ts` |
| `multi-turn-debug.ts` | Direct pushAudio multi-turn (2 turns, no WS) | ~50s | `npx tsx tests/multi-turn-debug.ts` |
| `bridge-multi-turn-debug.ts` | WS bridge multi-turn without adapter (2 turns) | ~50s | `npx tsx tests/bridge-multi-turn-debug.ts` |
| `bridge-adapter-debug.ts` | WS bridge + LiveKitRealtimeAdapter (2 turns) | ~60s | `npx tsx tests/bridge-adapter-debug.ts` |
| ~~`model-bridge-multi-turn.ts`~~ | **DEPRECATED** — non-canonical raw `model.session()` + WS bridge; fails 0/9 on Gemini 3.1. See [GH #30](https://github.com/kuralle/kuralle-agents/issues/30). | n/a | n/a |

> **Provider-native realtime:** authority-backed provider realtime lives in `@kuralle-agents/realtime-audio` (`VoiceEngine`). LiveKit voice in this package is cascaded-only (`KuralleRuntimeLLMAdapter`). The debug/bridge scripts below exercise raw provider/transport paths.

### Benchmark

| Test | What it compares | Time | Run |
|------|------------------|------|-----|
| `head-to-head-benchmark.ts` | Provider-native realtime vs LiveKit model vs cascaded STT→LLM→TTS, 3 turns each | ~4min | `npx tsx tests/head-to-head-benchmark.ts` |

The benchmark generates an HTML report at `packages/kuralle-e2e-tests/benchmark-report.html`.

### Diagnostics

| Test | Purpose | Run |
|------|---------|-----|
| `tool-schema-diagnostic.ts` | Trace tool parameter schemas through the LiveKit adapter round-trip | `npx tsx tests/tool-schema-diagnostic.ts` |

## Three Voice Pipelines

The tests exercise three different voice architectures:

```
Path A: Provider-native realtime (@kuralle-agents/realtime-audio)
  WS → VoiceEngine → GeminiLiveSession → Gemini Live API
  Single model call per turn. ~3-4s first-audio latency.

Path B: Gemini Native (LiveKit model)
  WS → KuralleGeminiRealtimeModel → GeminiLiveSession → Gemini Live API
  Same single LLM call, wrapped in LiveKit RealtimeModel API.

Path C: Cascaded (STT → LLM → TTS)
  WS → GeminiLiveSTT → Gemini Flash (text) → GeminiLiveTTS
  Three inference calls per turn. ~7-14s first-audio latency.
```

Path A uses `VoiceEngine` with the text `Runtime` for tools, flows, and handoffs. Path C uses `KuralleRuntimeLLMAdapter` (cascaded-only LiveKit integration).

## Harness Utilities

Shared test infrastructure in `harness/`:

| File | Purpose |
|------|---------|
| `fake_realtime_client.ts` | Drop-in `RealtimeAudioClient` fake. Canned text/tool responses, no API calls. |
| `ws_client.ts` | Programmatic WS client with paced audio sending and message collection. |
| `trace_collector.ts` | Records protocol messages, binary audio, timing for analysis. |
| `audio_fixtures.ts` | TTS fixture generation/loading with Gemini TTS caching. |
| `assertions.ts` | Reusable assertion functions for common E2E checks. |

## Audio Fixtures

Real API tests use TTS-generated PCM audio fixtures cached in `fixtures/`. These are generated on first run (requires Google API key) and reused on subsequent runs. The `fixtures/` directory is gitignored — each developer generates their own on first test run.

If no Google API key is available, `audio_fixtures.ts` falls back to synthetic sine wave audio.

## Writing New Tests

### Offline test (fake client) — recommended starting point

`FakeRealtimeAudioClient` implements `RealtimeAudioClient` from `@kuralle-agents/core/realtime`. Use it to unit-test realtime transport behavior (transcripts, tool round-trips, turn-complete) without API keys. See `tests/fake-client.test.ts`.

```typescript
import { describe, test, expect } from 'bun:test';
import { FakeRealtimeAudioClient } from '../harness/fake_realtime_client.js';
import type { RealtimeSessionConfig } from '@kuralle-agents/core/realtime';

test('canned tool + text', async () => {
  const client = new FakeRealtimeAudioClient({
    responses: {
      boston: {
        toolCalls: [{ name: 'check_weather', args: { city: 'Boston' } }],
        text: 'Sunny in Boston.',
      },
    },
  });
  await client.connect({ systemInstruction: 'test', tools: [] });

  let assistant = '';
  client.on('transcript', (t, role) => {
    if (role === 'assistant') assistant += t;
  });
  client.injectUserInput('weather in Boston');
  expect(assistant).toContain('Sunny');
});
```

For full agent/flow integration offline, use `bun test packages/kuralle-core` smoke tests or wire `VoiceEngine` + `createRuntime` in your own harness.

### Real API test (WS transport)
```typescript
import { WsTestClient } from '../harness/ws_client.js';
import { TraceCollector } from '../harness/trace_collector.js';
import { getOrGenerateFixture, generateSilence } from '../harness/audio_fixtures.js';

const trace = new TraceCollector();
const client = new WsTestClient({ url: `ws://127.0.0.1:${PORT}`, trace });
await client.waitForOpen();
await client.waitForJsonMessage('session_started', 10000);

// Send audio paced at real-time speed (critical for Gemini VAD)
const pcm = await getOrGenerateFixture('Hello world', 'test_hello.pcm');
await client.sendAudioFramesPaced(new Uint8Array(pcm), 960, 20);
await client.sendAudioFramesPaced(generateSilence(1000), 960, 20);

// Wait for response
await sleep(20000);
expect(trace.binaryChunks.length).toBeGreaterThan(0);
```
