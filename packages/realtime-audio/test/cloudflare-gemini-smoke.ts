/**
 * Live smoke test for CloudflareGeminiLiveClient.
 *
 * MUST run inside a Cloudflare Workers runtime (workerd / wrangler dev / deployed
 * Worker) — not Node. The `fetch(url, { headers: { Upgrade: "websocket" } })`
 * path that returns `response.webSocket` is Workers-exclusive. Node's `undici`
 * `fetch()` cannot upgrade to WebSocket.
 *
 * Usage (from a Worker entry or wrangler dev):
 *   const { runCloudflareGeminiSmoke } = await import(
 *     "@kuralle-agents/realtime-audio/dist/cloudflare/gemini-live.js"
 *   );
 *   await runCloudflareGeminiSmoke(env.GEMINI_API_KEY);
 *
 * Exit criteria:
 *   1. connect() resolves (setupComplete received)
 *   2. 200ms of silence audio round-trips without protocol error
 *   3. disconnect() cleanly closes the socket
 *
 * This file is not wired into `npm test` because it needs a Workers runtime.
 * Post-merge, run via a dedicated wrangler smoke harness for Cloudflare realtime voice infrastructure.
 */

import { CloudflareGeminiLiveClient } from '../src/cloudflare/gemini-live.js';

export async function runCloudflareGeminiSmoke(apiKey: string): Promise<void> {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required for the live smoke test');

  const client = new CloudflareGeminiLiveClient({ apiKey });

  let gotAudio = false;
  let gotError: string | null = null;
  client.on('audio', () => {
    gotAudio = true;
  });
  client.on('error', (e) => {
    gotError = e;
  });

  await client.connect({
    systemInstruction: 'Say the word "hello" once.',
    tools: [],
  });

  // 200ms of silence — 16kHz mono 16-bit = 3200 samples = 6400 bytes.
  const silence = new Uint8Array(6400);
  client.sendAudio(silence);

  // Wait up to 10s for model to respond (or error).
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !gotAudio && !gotError) {
    await new Promise((r) => setTimeout(r, 100));
  }

  await client.disconnect();

  if (gotError) throw new Error(`Smoke failed with error: ${gotError}`);
  if (!gotAudio) throw new Error('Smoke failed: no audio received within 10s');
}
