#!/usr/bin/env npx tsx
/**
 * @deprecated Raw model.session() + WS bridge driver.
 *
 * The KuralleGeminiRealtimeModel class has been removed in alpha. The raw
 * `model.session()` + custom WS bridge pattern this test exercised was
 * already documented as non-canonical (fails 0/9 on Gemini 3.1).
 *
 * Use `agentsession-realtime-authority-gemini-e2e.ts` for the canonical
 * pushAudio → Gemini → audio-back round-trip via createKuralleRealtimeAgent.
 */
console.warn(
  '\nlivekit-model-ws-bridge.ts retired — use agentsession-realtime-authority-gemini-e2e.ts\n',
);
process.exit(0);
