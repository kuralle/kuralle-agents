import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { voice } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';

import { TraceCollector } from '../harness/trace_collector.js';
import { WsTestClient } from '../harness/ws_client.js';
import { generateSilence } from '../harness/audio_fixtures.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
export const rootDir = join(currentDir, '../../..');

export type DirectTurn = {
  label: string;
  fixtureName: string;
  expectedTools?: string[];
  requireAudio?: boolean;
  waitForPostToolAudio?: boolean;
};

export type TurnResult = {
  label: string;
  chunks: number;
  bytes: number;
  tools: string[];
};

export function loadEnv(): void {
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
}

export function requireGeminiApiKey(): string {
  loadEnv();
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.log('SKIP: Set GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY');
    process.exit(0);
  }
  return apiKey;
}

export function fixture(name: string): Buffer {
  return readFileSync(join(rootDir, 'packages/e2e-tests/fixtures', name));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 45000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function runDirectAgentSessionScenario(options: {
  title: string;
  agent: voice.Agent;
  apiKey: string;
  turns: DirectTurn[];
  portBase?: number;
  maxToolSteps?: number;
}): Promise<{ trace: TraceCollector; turnResults: TurnResult[]; tools: string[] }> {
  console.log(options.title);

  const model = new google.beta.realtime.RealtimeModel({
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    voice: 'Kore',
    apiKey: options.apiKey,
  });

  const portBase = options.portBase ?? 19500;
  const port = portBase + Math.floor(Math.random() * 500);
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
      agent: options.agent,
      maxToolSteps: options.maxToolSteps ?? 5,
    });
  });

  await server.listen();

  const trace = new TraceCollector();
  const client = new WsTestClient({
    url: `ws://127.0.0.1:${port}`,
    trace,
  });
  const turnResults: TurnResult[] = [];

  try {
    await client.waitForOpen();
    const sessionStarted = await client.waitForJsonMessage('session_started', 15000);
    console.log(`session_started: ${sessionStarted.sessionId}`);

    for (let i = 0; i < options.turns.length; i += 1) {
      const turn = options.turns[i]!;
      const startChunks = trace.binaryChunks.length;
      const startBytes = trace.totalBinaryBytes;
      const startToolCount = trace.getMessages('tool_result').length;

      trace.startTurn(i, turn.label);
      await client.sendAudioFramesPaced(new Uint8Array(fixture(turn.fixtureName)), 960, 20);
      await client.sendAudioFramesPaced(generateSilence(1200), 960, 20);
      client.sendEndOfAudio();

      if (turn.expectedTools?.length) {
        await waitFor(
          `${turn.label} tool_result`,
          () => {
            const tools = trace.getMessages('tool_result')
              .slice(startToolCount)
              .map((m) => String(m.toolName));
            return turn.expectedTools!.every((tool) => tools.includes(tool));
          },
        );
      }

      if (turn.requireAudio !== false) {
        const toolResultChunks = trace.binaryChunks.length;
        await waitFor(
          `${turn.label} audio`,
          () => trace.binaryChunks.length > (turn.waitForPostToolAudio ? toolResultChunks : startChunks),
        );
      }
      await sleep(5000);
      trace.endTurn();

      const tools = trace.getMessages('tool_result')
        .slice(startToolCount)
        .map((m) => String(m.toolName));
      const result = {
        label: turn.label,
        chunks: trace.binaryChunks.length - startChunks,
        bytes: trace.totalBinaryBytes - startBytes,
        tools,
      };
      turnResults.push(result);
      console.log(`${turn.label}: ${result.chunks} chunks, ${result.bytes} bytes, tools=${tools.join(',')}`);
    }

    return {
      trace,
      turnResults,
      tools: trace.getMessages('tool_result').map((m) => String(m.toolName)),
    };
  } finally {
    await Promise.race([
      (async () => {
        client.close();
        await sleep(500);
        await server.close();
        await model.close();
      })(),
      sleep(5000).then(() => {
        console.warn('teardown timed out; continuing');
      }),
    ]);
  }
}
