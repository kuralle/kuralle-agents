#!/usr/bin/env npx tsx
/**
 * E2E Test: WS Transport → Cascaded Pipeline (STT → Runtime → TTS)
 *
 * Validates the full cascaded voice pipeline through the WS transport:
 *   WS client → WebSocketAgentServer
 *     → KuralleVoiceSession (STT → KuralleRuntimeLLMAdapter → TTS)
 *     → WebSocketAudioOutput (binary frames back to client)
 *
 * This test exercises:
 *   1. WS connection and session_started handshake
 *   2. Greeting delivery (agent_text + binary audio)
 *   3. Text-driven turn (user_text → agent_text + audio)
 *   4. Audio-driven turn (binary frames + end_of_audio → STT → agent response)
 *   5. Disconnect during active playback (stability)
 *   6. Multi-turn conversation continuity
 *
 * Provider requirements:
 *   - STT: LiveKit inference.STT (Deepgram Nova-3 via LiveKit Cloud)
 *   - TTS: LiveKit inference.TTS (Cartesia Sonic-3 via LiveKit Cloud)
 *   - Requires LIVEKIT_URL + LIVEKIT_API_KEY (LiveKit Cloud inference gateway)
 *   - Also requires OPENAI_API_KEY for the hospital agent LLM backend
 *   - Skips if required keys are missing
 *
 * Run:
 *   npx tsx packages/kuralle-livekit-plugin-transport-ws/test/e2e/ws-cascaded-e2e.ts
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLogger, inference, voice } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { WebSocketAgentServer } from '../../src/server.js';

import { TraceCollector } from './harness/trace_collector.js';
import { WsTestClient } from './harness/ws_client.js';
import { getOrGenerateFixture, TEST_UTTERANCES, generateSilence } from './harness/audio_fixtures.js';
import {
  runAssertions,
  printAssertionResults,
  assertSessionStarted,
  assertAgentTextReceived,
  assertBinaryAudioReceived,
} from './harness/assertions.js';

// ─── Env ────────────────────────────────────────────────────────────────────

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(currentDir, '../../../..');

// Load .env
try {
  const envFile = readFileSync(join(rootDir, '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch { /* no .env */ }

// Check for required provider keys
const hasLiveKit = !!process.env.LIVEKIT_URL && !!process.env.LIVEKIT_API_KEY;
const hasOpenAI = !!process.env.OPENAI_API_KEY;

if (!hasLiveKit) {
  console.log('SKIP: Set LIVEKIT_URL + LIVEKIT_API_KEY to run cascaded e2e (LiveKit inference gateway required for STT/TTS)');
  process.exit(0);
}

if (!hasOpenAI) {
  console.log('SKIP: Set OPENAI_API_KEY to run cascaded e2e (hospital agent LLM backend)');
  process.exit(0);
}

initializeLogger({ pretty: true });

// ─── Runtime Setup ──────────────────────────────────────────────────────────

function createSttProvider() {
  return new inference.STT({
    model: 'deepgram/nova-3',
    language: 'multi',
  });
}

function createTtsProvider() {
  return new inference.TTS({
    model: 'cartesia/sonic-3',
    voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  E2E: WS Transport → Cascaded Pipeline (STT→Runtime→TTS)');
  console.log('  Stack: KuralleVoiceSession via WebSocketAgentServer');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. Create the hospital runtime
  console.log('Phase 1: Runtime Construction');

  // Dynamically import the hospital runtime from the starter
  // (avoids hard dependency on starter package structure)
  let createHospitalRuntime: () => unknown;
  try {
    const mod = await import(
      join(rootDir, 'apps/playground/livekit-starters/livekit-agent-starter/src/aria-agent/runtime.ts')
    );
    createHospitalRuntime = mod.createHospitalRuntime;
  } catch (err) {
    console.log(`  Cannot import hospital runtime: ${err instanceof Error ? err.message : String(err)}`);
    console.log('  SKIP: Hospital runtime not available');
    process.exit(0);
  }

  const runtime = createHospitalRuntime();
  const vad = await silero.VAD.load();
  console.log('  Runtime and VAD loaded\n');

  // 2. Audio fixtures
  console.log('Phase 2: Audio Fixtures');
  const audioFixtures: Buffer[] = [];
  for (const utterance of TEST_UTTERANCES) {
    const pcm = await getOrGenerateFixture(utterance.text, utterance.filename);
    audioFixtures.push(pcm);
  }
  console.log(`  ${audioFixtures.length} fixtures ready\n`);

  // 3. Start WS server
  console.log('Phase 3: WS Server (Cascaded Mode)');
  const PORT = 19200 + Math.floor(Math.random() * 800);
  const server = new WebSocketAgentServer({
    port: PORT,
    host: '127.0.0.1',
    defaultSampleRate: 24000,
    defaultNumChannels: 1,
  });

  server.onConnection(async (transport) => {
    const voiceSession = new KuralleVoiceSession({
      runtime: runtime as Parameters<typeof KuralleVoiceSession.prototype.start>[0] extends never ? never : unknown,
      stt: createSttProvider(),
      tts: createTtsProvider(),
      vad,
      voiceOptions: {
        preemptiveGeneration: false,
        minEndpointingDelay: 300,
        maxEndpointingDelay: 1400,
        minInterruptionWords: 2,
      },
      greeting: 'Hello. I can help with appointments and hospital information. How can I help today?',
    } as ConstructorParameters<typeof KuralleVoiceSession>[0]);

    const session = await server.startSession(transport, voiceSession);

    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      console.error(`  [cascaded] session error: ${transport.id}`, event.error);
    });
    session.on(voice.AgentSessionEventTypes.Close, () => {
      console.log(`  [cascaded] session closed: ${transport.id}`);
    });
  });

  await server.listen();
  console.log(`  WS server listening on ws://127.0.0.1:${PORT}\n`);

  // 4. Test: Greeting
  console.log('Phase 4: Scenario — Greeting');
  const trace = new TraceCollector();
  const client = new WsTestClient({
    url: `ws://127.0.0.1:${PORT}`,
    trace,
  });
  await client.waitForOpen();

  const sessionMsg = await client.waitForJsonMessage('session_started', 5000);
  console.log(`  session_started: sessionId=${sessionMsg.sessionId}`);

  // Wait for greeting
  console.log('  Waiting for greeting (10s)...');
  trace.startTurn(0, 'greeting');
  await sleep(10000);
  trace.endTurn();

  const greetingTexts = trace.getMessages('agent_text');
  const greetingAudioCount = trace.binaryChunks.length;
  console.log(`  Greeting: ${greetingTexts.length} text msgs, ${greetingAudioCount} audio chunks\n`);

  // 5. Test: Text Turn
  console.log('Phase 5: Scenario — Text Turn');
  trace.startTurn(1, 'text_turn');
  client.sendUserText('I would like to book an appointment for next Tuesday.');
  console.log('  Sent user_text, waiting 15s for response...');
  await sleep(15000);
  trace.endTurn();

  const textTurnMsgs = trace.getMessages('agent_text');
  const textTurnAudio = trace.binaryChunks.length;
  console.log(`  After text turn: ${textTurnMsgs.length} total text msgs, ${textTurnAudio} total audio chunks\n`);

  // 6. Test: Audio Turn
  console.log('Phase 6: Scenario — Audio Turn');
  trace.startTurn(2, 'audio_turn');
  client.sendAudioFrames(new Uint8Array(audioFixtures[0]));
  client.sendAudioFrames(generateSilence(500));
  client.sendEndOfAudio();
  console.log('  Sent audio frames + end_of_audio, waiting 15s...');
  await sleep(15000);
  trace.endTurn();

  const audioTurnMsgs = trace.getMessages('agent_text');
  const audioTurnAudioCount = trace.binaryChunks.length;
  console.log(`  After audio turn: ${audioTurnMsgs.length} total text msgs, ${audioTurnAudioCount} total audio chunks\n`);

  // 7. Test: Disconnect stability
  console.log('Phase 7: Scenario — Disconnect During Activity');
  // Send a text and immediately close
  client.sendUserText('Tell me about the cardiology department.');
  await sleep(500); // Let some output begin
  client.close();
  console.log('  Client disconnected during activity');
  await sleep(2000); // Wait for server to handle cleanup

  // Verify server is still alive by connecting a new client
  const trace2 = new TraceCollector();
  const verifyClient = new WsTestClient({
    url: `ws://127.0.0.1:${PORT}`,
    trace: trace2,
  });
  await verifyClient.waitForOpen();
  const verifyMsg = await verifyClient.waitForJsonMessage('session_started', 5000);
  verifyClient.close();
  const serverSurvived = verifyMsg.type === 'session_started';
  console.log(`  Server survived disconnect: ${serverSurvived}\n`);

  // 8. Cleanup
  console.log('Phase 8: Teardown');
  await server.close();
  console.log('  Server closed');

  // 9. Trace summary
  console.log('\nPhase 9: Trace Analysis');
  trace.printSummary();

  // 10. Assertions
  console.log('\nPhase 10: Assertions');
  const results = runAssertions([
    {
      name: 'Session started',
      check: () => assertSessionStarted(trace),
    },
    {
      name: 'Greeting text received',
      check: () => {
        const texts = trace.getMessages('agent_text');
        const withContent = texts.filter(
          (m) => typeof m.text === 'string' && m.text.length > 0,
        );
        return {
          pass: withContent.length > 0,
          detail: `${withContent.length} agent_text messages with content`,
        };
      },
    },
    {
      name: 'Greeting audio received',
      check: () => assertBinaryAudioReceived(trace),
    },
    {
      name: 'Post-text-turn response received',
      check: () => {
        // After the greeting, there should be additional agent_text messages
        const texts = trace.getMessages('agent_text');
        return {
          pass: texts.length > 1,
          detail: `${texts.length} total agent_text messages`,
        };
      },
    },
    {
      name: 'Server survived client disconnect',
      check: () => ({
        pass: serverSurvived,
        detail: serverSurvived ? 'New connection accepted after disconnect' : 'Server died',
      }),
    },
  ]);

  const allPass = printAssertionResults(results);
  process.exit(allPass ? 0 : 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
