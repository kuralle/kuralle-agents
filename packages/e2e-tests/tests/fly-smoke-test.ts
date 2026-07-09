/**
 * Smoke test: Send audio to deployed Fly.io voice agent, verify response.
 *
 * Usage:
 *   npx tsx packages/e2e-tests/tests/fly-smoke-test.ts [wss://your-app.fly.dev]
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceCollector } from '../harness/trace_collector.js';
import { WsTestClient } from '../harness/ws_client.js';
import { generateSilence } from '../harness/audio_fixtures.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(currentDir, '../fixtures');

const wsUrl = process.argv[2] || 'wss://kuralle-voice-agent.fly.dev';
console.log(`Fly smoke test → ${wsUrl}`);

const trace = new TraceCollector();
const client = new WsTestClient({ url: wsUrl, trace });

try {
  await client.waitForOpen(10000);
  console.log('Connected');

  const sessionStarted = await client.waitForJsonMessage('session_started', 15000);
  console.log('session_started:', JSON.stringify(sessionStarted));

  // Send 'hello' audio
  const pcm = readFileSync(join(fixturesDir, 'bench_hello.pcm'));
  trace.startTurn(0, 'hello');
  await client.sendAudioFramesPaced(new Uint8Array(pcm), 960, 20);
  await client.sendAudioFramesPaced(generateSilence(1200), 960, 20);
  client.sendEndOfAudio();

  // Wait for audio response
  const start = Date.now();
  while (Date.now() - start < 45000) {
    if (trace.binaryChunks.length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Wait a bit more for full response
  await new Promise((r) => setTimeout(r, 5000));
  trace.endTurn();

  // Results
  console.log(`\nAudio chunks received: ${trace.binaryChunks.length}`);
  console.log(`Total bytes: ${trace.totalBinaryBytes}`);

  const msgTypes = [...new Set(trace.jsonMessages.map((m) => m.type))];
  for (const t of msgTypes) {
    console.log(`  ${t}: ${trace.getMessages(t).length}`);
  }

  const transcripts = trace.getMessages('user_transcription').filter((m) => m.isFinal);
  if (transcripts.length) console.log(`User transcript: "${transcripts.map((t) => t.text).join(' ')}"`);

  trace.printSummary();

  const pass = trace.binaryChunks.length > 0;
  console.log(`\nFly smoke test: ${pass ? 'PASS' : 'FAIL'}`);
  client.close();
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  client.close();
  process.exit(1);
}
