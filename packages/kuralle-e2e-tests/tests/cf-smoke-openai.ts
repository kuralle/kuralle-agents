/**
 * Cloudflare OpenAI (Realtime family) voice-agent smoke — deployed worker,
 * real audio in, real audio/transcript out, wrangler tail piped in parallel.
 *
 * Runs end-to-end against the deployed CF worker:
 *   https://cf-voice-realtime-openai.mithushancj.workers.dev
 *
 * Usage:
 *   npx tsx packages/kuralle-e2e-tests/tests/cf-smoke-openai.ts
 *     [wss-url] [instance-name]
 *
 * The worker's PROVIDER env var selects OpenAI (default) vs xAI; this smoke
 * hits whatever the worker is currently configured for. Secrets (OPENAI_API_KEY
 * or XAI_API_KEY) must be set on the worker for `start_call` to succeed.
 */

import { runCfVoiceSmoke } from './cf_smoke_harness.js';

const DEFAULT_WS = 'wss://cf-voice-realtime-openai.mithushancj.workers.dev';
const DEFAULT_ACCOUNT = 'a8fe2d60bcdf7954d347214ebab95c1a';

async function main() {
  const wsUrl = process.argv[2] ?? DEFAULT_WS;
  const instance = process.argv[3] ?? `smoke-${Date.now()}`;
  // `CfVoiceRealtimeOpenAIAgent` → `cf-voice-realtime-open-a-i-agent` per the
  // agents SDK's `camelCaseToKebabCase`: every uppercase letter produces a
  // dash, so `OpenAI` → `open-a-i`. Confirmed in sub-routing.ts.
  const instancePath = `/agents/cf-voice-realtime-open-a-i-agent/${instance}`;

  const result = await runCfVoiceSmoke({
    wsUrl,
    instancePath,
    pcmFixture: 'bench_hello.pcm',
    tailWorker: 'cf-voice-realtime-openai',
    accountId: DEFAULT_ACCOUNT,
    tailDurationMs: 60_000,
    audioFixtureRate: 24000,
    audioInputRate: 24000, // OpenAI Realtime uses PCM16 @ 24kHz
    label: 'OpenAI CF (OpenAI-family realtime + Adapter)',
  });

  process.exit(result.pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
