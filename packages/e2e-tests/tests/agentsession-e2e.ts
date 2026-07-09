#!/usr/bin/env npx tsx
/**
 * E2E: WebSocketAgentServer.startRealtimeSession()
 *
 * Validates Path D:
 *   WS client -> WebSocketTransportAdapter -> AgentSession
 *     -> @livekit/agents-plugin-google RealtimeModel -> Gemini Live
 *     -> voice.Agent tools -> binary audio back to WS
 *
 * Run:
 *   npx tsx packages/e2e-tests/tests/agentsession-e2e.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLogger, llm, voice } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { z } from 'zod';
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';

import { TraceCollector } from '../harness/trace_collector.js';
import { WsTestClient } from '../harness/ws_client.js';
import { generateSilence } from '../harness/audio_fixtures.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(currentDir, '../../..');

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
} catch {
  // .env is optional; CI can provide environment variables directly.
}

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.log('SKIP: Set GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY');
  process.exit(0);
}

initializeLogger({ pretty: true, level: 'warn' });

function fixture(name: string): Buffer {
  return readFileSync(join(rootDir, 'packages/e2e-tests/fixtures', name));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 30000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function sendTurn(
  client: WsTestClient,
  trace: TraceCollector,
  index: number,
  label: string,
  pcm: Buffer,
): Promise<{ chunks: number; bytes: number }> {
  const startChunks = trace.binaryChunks.length;
  const startBytes = trace.totalBinaryBytes;

  trace.startTurn(index, label);
  await client.sendAudioFramesPaced(new Uint8Array(pcm), 960, 20);
  await client.sendAudioFramesPaced(generateSilence(1200), 960, 20);
  client.sendEndOfAudio();

  await waitFor(`audio for ${label}`, () => trace.binaryChunks.length > startChunks, 45000);
  await sleep(5000);
  trace.endTurn();

  return {
    chunks: trace.binaryChunks.length - startChunks,
    bytes: trace.totalBinaryBytes - startBytes,
  };
}

async function main(): Promise<void> {
  console.log('AgentSession direct transport E2E');
  let exitCode = 1;

  const model = new google.beta.realtime.RealtimeModel({
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    voice: 'Kore',
    apiKey,
  });

  const agent = new voice.Agent({
    instructions: [
      'You are a concise voice assistant.',
      'Keep replies to one or two short sentences.',
      'Always call check_weather when the user asks about weather.',
    ].join('\n'),
    tools: {
      check_weather: llm.tool({
        description: 'Check current weather for a city.',
        parameters: z.object({
          city: z.string().describe('City name'),
        }),
        execute: async ({ city }) => {
          console.log(`[tool] check_weather city=${city}`);
          return {
            city,
            temperature: 22,
            unit: 'celsius',
            condition: 'partly cloudy',
          };
        },
      }),
    },
  });

  const port = 19400 + Math.floor(Math.random() * 500);
  const server = new WebSocketAgentServer({
    port,
    host: '127.0.0.1',
    defaultSampleRate: 24000,
    defaultNumChannels: 1,
    autoSendSessionStarted: false,
  });

  server.onConnection(async (adapter) => {
    await server.startRealtimeSession(adapter, {
      model,
      agent,
      maxToolSteps: 5,
    });
  });

  await server.listen();

  const trace = new TraceCollector();
  const client = new WsTestClient({
    url: `ws://127.0.0.1:${port}`,
    trace,
  });

  try {
    await client.waitForOpen();
    const sessionStarted = await client.waitForJsonMessage('session_started', 15000);
    console.log(`session_started: ${sessionStarted.sessionId}`);

    const hello = await sendTurn(client, trace, 0, 'hello', fixture('bench_hello.pcm'));
    console.log(`turn1 audio: ${hello.chunks} chunks, ${hello.bytes} bytes`);

    const weatherStartChunks = trace.binaryChunks.length;
    const weatherStartBytes = trace.totalBinaryBytes;
    const beforeToolCount = trace.getMessages('tool_result').length;
    trace.startTurn(1, 'weather_tokyo');
    await client.sendAudioFramesPaced(new Uint8Array(fixture('mt_weather_tokyo.pcm')), 960, 20);
    await client.sendAudioFramesPaced(generateSilence(1200), 960, 20);
    client.sendEndOfAudio();

    await waitFor(
      'check_weather tool_result',
      () => trace.getMessages('tool_result').length > beforeToolCount,
      45000,
    );
    const toolResultAt = trace.binaryChunks.length;
    await waitFor('post-tool audio', () => trace.binaryChunks.length > toolResultAt, 45000);
    await sleep(5000);
    trace.endTurn();
    const weather = {
      chunks: trace.binaryChunks.length - weatherStartChunks,
      bytes: trace.totalBinaryBytes - weatherStartBytes,
    };
    console.log(`turn2 audio: ${weather.chunks} chunks, ${weather.bytes} bytes`);

    const tools = trace.getMessages('tool_result').map((m) => String(m.toolName));
    const passed = hello.chunks > 0 && weather.chunks > 0 && tools.includes('check_weather');

    trace.printSummary();
    console.log(`FINAL: ${passed ? 'PASS' : 'FAIL'} tools=${tools.join(',')}`);
    exitCode = passed ? 0 : 1;
  } finally {
    await Promise.race([
      (async () => {
        client.close();
        await sleep(500);
        await server.close();
        await model.close();
      })(),
      sleep(5000).then(() => {
        console.warn('teardown timed out; forcing process exit');
      }),
    ]);
    process.exit(exitCode);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
