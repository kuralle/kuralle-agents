/**
 * Cloudflare Gemini voice-agent smoke — deployed worker,
 * real audio in, real audio/transcript out, wrangler tail piped in parallel.
 *
 * Runs end-to-end against the deployed CF worker:
 *   https://cf-voice-realtime-gemini.mithushancj.workers.dev
 *
 * Usage:
 *   npx tsx packages/e2e-tests/tests/cf-smoke-gemini.ts
 *     [wss-url] [instance-name]
 *
 * Defaults to the deployed URL + a random instance id (so each run gets a
 * fresh DO). Account id is pinned for wrangler tail.
 */

import { runCfVoiceSmoke } from './cf_smoke_harness.js';

const DEFAULT_WS = 'wss://cf-voice-realtime-gemini.mithushancj.workers.dev';
const DEFAULT_ACCOUNT = 'YOUR_CF_ACCOUNT_ID';

async function main() {
  const wsUrl = process.argv[2] ?? DEFAULT_WS;
  const instance = process.argv[3] ?? `smoke-${Date.now()}`;
  // Agents SDK kebab-cases the class name: `CfVoiceRealtimeAgent` →
  // `cf-voice-realtime-agent` (per `camelCaseToKebabCase` in agents/utils.ts).
  const instancePath = `/agents/cf-voice-realtime-agent/${instance}`;

  const result = await runCfVoiceSmoke({
    wsUrl,
    instancePath,
    pcmFixture: 'bench_hello.pcm',
    tailWorker: 'cf-voice-realtime-gemini',
    accountId: DEFAULT_ACCOUNT,
    tailDurationMs: 60_000,
    audioFixtureRate: 24000,
    audioInputRate: 16000, // Gemini Live expects PCM16 @ 16kHz
    label: 'Gemini CF (Cloudflare voice + Gemini Live + Adapter)',
  });

  process.exit(result.pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
