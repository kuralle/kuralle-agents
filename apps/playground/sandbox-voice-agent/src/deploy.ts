#!/usr/bin/env npx tsx
/**
 * Deploy an Kuralle Gemini Live voice agent inside a Vercel Sandbox.
 *
 * Run from apps/playground/sandbox-voice-agent:
 *   npx tsx src/deploy.ts
 */

import { Sandbox, type Command } from '@vercel/sandbox';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { DeployMode } from './deploy-types.js';
import { createServerCode } from './sandbox-server-code.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(currentDir, '..');
const repoRoot = join(projectDir, '../../..');

const PORT = 3000;
const SANDBOX_TTL_MS = 10 * 60 * 1000;
const HEALTH_PATH = '/__kuralle_health';
const SNAPSHOT_CACHE_PATH = join(projectDir, '.sandbox-snapshot.json');
const SELF_TEST_CLIENT = 'self-test';
const SESSION_ENDED_MARKER = '__KURALLE_SESSION_ENDED__';

const sandboxPackage = {
  name: 'kuralle-sandbox-agent',
  private: true,
  type: 'module',
  dependencies: {
    '@kuralle-agents/core': '0.9.9',
    '@kuralle-agents/realtime-audio': '0.9.9',
    '@kuralle-agents/livekit-plugin': '0.9.9',
    '@kuralle-agents/livekit-plugin-transport-ws': '0.9.9',
    '@livekit/agents': '^1.2.6',
    '@livekit/agents-plugin-google': '^1.2.6',
    '@livekit/rtc-node': '>=0.12.0',
    ai: '^6.0.0',
    ws: '^8.19.0',
    zod: '^3.23.0',
  },
};

type SnapshotCache = {
  snapshotId: string;
  dependencySignature: string;
  createdAt: string;
};

type ScenarioSelfTest = {
  fixtures: string[];
  expectedToolResults: number;
  expectedToolNames?: string[];
  advanceAfterToolResults?: string[];
  minTurnCompletes?: number;
  minAudioTurns?: number;
};

type StopReason = 'ctrl-c' | 'session-ended' | 'timeout' | 'ready' | 'error';

export async function main(): Promise<void> {
  await deploy('transport');
}

export async function deploy(mode: DeployMode = 'transport'): Promise<void> {
  loadEnvFiles([join(projectDir, '.env.local'), join(repoRoot, '.env')]);

  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!googleKey) {
    throw new Error('Set GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY in the repo root .env');
  }

  const skipSnapshot = process.argv.includes('--no-snapshot') || process.env.KURALLE_NO_SNAPSHOT === '1';
  const skipAudioTest = process.argv.includes('--skip-audio-test') || process.env.KURALLE_SKIP_AUDIO_TEST === '1';
  const exitAfterReady = process.argv.includes('--exit-after-ready') || process.env.KURALLE_EXIT_AFTER_READY === '1';
  const readyToken = randomUUID();
  const useScenarioSelfTest = mode === 'agentsession';
  const scenarioSelfTest: ScenarioSelfTest | undefined =
    mode === 'agentsession'
      ? {
          fixtures: ['mt_weather_tokyo.pcm', 'mt_time_there.pcm'],
          expectedToolResults: 2,
          expectedToolNames: ['check_weather', 'get_time'],
          advanceAfterToolResults: ['check_weather'],
        }
      : undefined;

  const modeLabels: Record<DeployMode, string> = {
    transport: 'Kuralle + Gemini Live -> Vercel Sandbox',
    agentsession: 'Kuralle + AgentSession direct (Path D) -> Vercel Sandbox',
  };
  console.log(modeLabels[mode]);
  console.log(`Port: ${PORT}`);
  console.log(`Snapshot: ${skipSnapshot ? 'disabled' : 'enabled'}`);
  console.log(`Audio self-test: ${skipAudioTest ? 'skipped' : 'enabled'}\n`);

  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | null = null;
  let stopLogs: (() => void) | null = null;
  let stopRequested = false;
  let ttlTimer: NodeJS.Timeout | undefined;

  const stopPromise = new Promise<StopReason>((resolveStop) => {
    const requestStop = (reason: StopReason) => {
      if (stopRequested) return;
      stopRequested = true;
      resolveStop(reason);
    };

    process.once('SIGINT', () => requestStop('ctrl-c'));
    process.once('SIGTERM', () => requestStop('ctrl-c'));
    ttlTimer = setTimeout(() => requestStop('timeout'), SANDBOX_TTL_MS);

    void (async () => {
      try {
        let snapshotId = skipSnapshot ? undefined : await getOrCreateSnapshot(mode);
        try {
          sandbox = await createRuntimeSandbox({ snapshotId, googleKey, readyToken, mode });
        } catch (err) {
          if (!snapshotId || skipSnapshot || process.env.KURALLE_SANDBOX_SNAPSHOT_ID) {
            throw err;
          }

          console.warn(
            `Snapshot ${snapshotId} could not be used; rebuilding dependency snapshot. ` +
              (err instanceof Error ? err.message : String(err)),
          );
          rmSync(SNAPSHOT_CACHE_PATH, { force: true });
          snapshotId = await getOrCreateSnapshot(mode);
          sandbox = await createRuntimeSandbox({ snapshotId, googleKey, readyToken, mode });
        }

        const httpUrl = sandbox.domain(PORT);
        const wsUrl = httpUrl.replace(/^https:\/\//, 'wss://');
        console.log(`Sandbox: ${sandbox.sandboxId}`);
        if (snapshotId) console.log(`Snapshot: ${snapshotId}`);
        console.log(`HTTP URL: ${httpUrl}`);
        console.log(`WSS URL:  ${wsUrl}\n`);

        if (snapshotId) {
          // Keep server source fresh even when the dependency snapshot is reused.
          await writeSandboxFiles(sandbox, mode);
        }

        console.log('Starting voice agent server...');
        const serverCmd = await sandbox.runCommand({
          cmd: 'node',
          args: ['server.mjs'],
          detached: true,
        });

        stopLogs = streamServerLogs(serverCmd, (event) => {
          if (event.client !== SELF_TEST_CLIENT) {
            console.log(`Session ended: ${event.sessionId ?? 'unknown'} (${event.reason ?? 'unknown'})`);
            requestStop('session-ended');
          }
        });

        const health = await waitForOwnHealth(httpUrl, readyToken);
        console.log(`Ready: pid=${health.pid} uptime=${health.uptime.toFixed(1)}s`);
        console.log(`Connect browser client to: ${wsUrl}\n`);

        if (!skipAudioTest) {
          const result = await verifyAudioRoundTrip(`${wsUrl}?client=${SELF_TEST_CLIENT}`, {
            fixtureNames: useScenarioSelfTest ? scenarioSelfTest!.fixtures : ['bench_hello.pcm'],
            expectedToolResults: useScenarioSelfTest ? scenarioSelfTest!.expectedToolResults : 0,
            expectedToolNames: useScenarioSelfTest ? scenarioSelfTest!.expectedToolNames : undefined,
            advanceAfterToolResults: useScenarioSelfTest ? scenarioSelfTest!.advanceAfterToolResults : undefined,
            minAudioTurns: useScenarioSelfTest ? scenarioSelfTest!.minAudioTurns : undefined,
          });
          console.log(
            [
              'Audio self-test: PASS',
              `in=${result.sentChunks} chunks/${result.sentBytes} bytes`,
              `out=${result.receivedChunks} chunks/${result.receivedBytes} bytes`,
              `firstAudio=${result.firstAudioMs}ms`,
              scenarioSelfTest && scenarioSelfTest.expectedToolResults > 0
                ? `tools=${result.toolResults.length}/${scenarioSelfTest.expectedToolResults}:${result.toolResults.join(',')}`
                : undefined,
            ]
              .filter(Boolean)
              .join(' '),
          );
          console.log(`Browser WSS URL: ${wsUrl}\n`);
        }

        if (exitAfterReady) {
          requestStop('ready');
          return;
        }

        console.log('Keeping sandbox alive until a browser session ends, Ctrl+C, or 10 minutes elapse.');
      } catch (err) {
        console.error('Deploy failed:', err instanceof Error ? err.message : err);
        requestStop('error');
      }
    })();
  });

  const reason = await stopPromise;
  if (ttlTimer) clearTimeout(ttlTimer);

  if (stopLogs) stopLogs();
  if (sandbox) {
    console.log(`\nStopping sandbox (${reason})...`);
    await sandbox.stop().catch((err) => {
      console.error('Sandbox stop failed:', err instanceof Error ? err.message : err);
    });
    console.log('Sandbox stopped.');
  }

  if (reason === 'error') {
    process.exitCode = 1;
  }
}

async function getOrCreateSnapshot(mode: DeployMode): Promise<string | undefined> {
  const explicitSnapshot = process.env.KURALLE_SANDBOX_SNAPSHOT_ID;
  if (explicitSnapshot) {
    console.log(`Using snapshot from KURALLE_SANDBOX_SNAPSHOT_ID: ${explicitSnapshot}`);
    return explicitSnapshot;
  }

  const dependencySignature = hash(JSON.stringify(sandboxPackage.dependencies));
  const cached = readSnapshotCache();
  if (cached?.dependencySignature === dependencySignature) {
    console.log(`Using cached dependency snapshot: ${cached.snapshotId}`);
    return cached.snapshotId;
  }

  if (cached) {
    console.log('Cached snapshot dependency signature changed; creating a new snapshot.');
    rmSync(SNAPSHOT_CACHE_PATH, { force: true });
  }

  console.log('Creating dependency snapshot (first run may take about 60s)...');
  const t0 = Date.now();
  const setupSandbox = await Sandbox.create({
    runtime: 'node24',
    ports: [PORT],
    timeout: SANDBOX_TTL_MS,
  });

  try {
    await writeSandboxFiles(setupSandbox, mode);

    const install = await setupSandbox.runCommand('npm', ['install', '--no-audit', '--no-fund']);
    if (install.exitCode !== 0) {
      const output = await install.output('both').catch(() => '');
      throw new Error(`npm install failed with exit ${install.exitCode}\n${output.slice(-4000)}`);
    }

    const snapshot = await setupSandbox.snapshot({ expiration: 0 });
    const snapshotId = snapshot.snapshotId;
    writeFileSync(
      SNAPSHOT_CACHE_PATH,
      JSON.stringify({ snapshotId, dependencySignature, createdAt: new Date().toISOString() } satisfies SnapshotCache, null, 2),
    );
    console.log(`Created snapshot ${snapshotId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return snapshotId;
  } catch (err) {
    await setupSandbox.stop().catch(() => {});
    throw err;
  }
}

async function createRuntimeSandbox(params: {
  snapshotId: string | undefined;
  googleKey: string;
  readyToken: string;
  mode: DeployMode;
}): Promise<Awaited<ReturnType<typeof Sandbox.create>>> {
  const env = {
    GOOGLE_API_KEY: params.googleKey,
    READY_TOKEN: params.readyToken,
  };

  if (params.snapshotId) {
    const t0 = Date.now();
    const sandbox = await Sandbox.create({
      source: { type: 'snapshot', snapshotId: params.snapshotId },
      ports: [PORT],
      timeout: SANDBOX_TTL_MS,
      env,
    });
    console.log(`Created sandbox from snapshot in ${Date.now() - t0}ms`);
    return sandbox;
  }

  const t0 = Date.now();
  const sandbox = await Sandbox.create({
    runtime: 'node24',
    ports: [PORT],
    timeout: SANDBOX_TTL_MS,
    env,
  });
  console.log(`Created sandbox in ${Date.now() - t0}ms`);

  await writeSandboxFiles(sandbox, params.mode);
  const install = await sandbox.runCommand('npm', ['install', '--no-audit', '--no-fund']);
  if (install.exitCode !== 0) {
    const output = await install.output('both').catch(() => '');
    throw new Error(`npm install failed with exit ${install.exitCode}\n${output.slice(-4000)}`);
  }

  return sandbox;
}

async function writeSandboxFiles(
  sandbox: Awaited<ReturnType<typeof Sandbox.create>>,
  mode: DeployMode,
): Promise<void> {
  await sandbox.writeFiles([
    { path: 'server.mjs', content: createServerCode(mode) },
    { path: 'package.json', content: JSON.stringify(sandboxPackage, null, 2) },
  ]);
}

async function waitForOwnHealth(httpUrl: string, readyToken: string): Promise<{ pid: number; uptime: number }> {
  const startedAt = Date.now();
  const timeoutMs = 75_000;
  const healthUrl = new URL(HEALTH_PATH, httpUrl);
  healthUrl.searchParams.set('readyToken', readyToken);

  let lastError = 'not ready';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const resp = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timeout);

      const text = await resp.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      if (
        resp.ok &&
        body.status === 'ok' &&
        body.agent === 'kuralle-gemini-live' &&
        body.readyToken === readyToken &&
        typeof body.pid === 'number' &&
        typeof body.uptime === 'number'
      ) {
        return { pid: body.pid, uptime: body.uptime };
      }
      lastError = `unexpected health body: ${text.slice(0, 160)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(750);
  }

  throw new Error(`Timed out waiting for the sandbox server's own health endpoint: ${lastError}`);
}

async function verifyAudioRoundTrip(
  wsUrl: string,
  options: {
    requireTurnComplete?: boolean;
    fixtureNames?: string[];
    expectedToolResults?: number;
    expectedToolNames?: string[];
    advanceAfterToolResults?: string[];
    minTurnCompletes?: number;
    minAudioTurns?: number;
  } = {},
): Promise<{
  sentBytes: number;
  sentChunks: number;
  receivedBytes: number;
  receivedChunks: number;
  firstAudioMs: number;
  turnComplete: boolean;
  turnCompletes: number;
  expectedTurns: number;
  turnAudioChunks: number[];
  toolResults: string[];
}> {
  const fixtureNames = options.fixtureNames?.length ? options.fixtureNames : ['bench_hello.pcm'];
  const fixtures = fixtureNames.map((name) => readFileSync(join(repoRoot, 'packages/kuralle-e2e-tests/fixtures', name)));
  const silence = Buffer.alloc(960);
  const expectedTurns = options.requireTurnComplete ? fixtures.length : 1;
  const minTurnCompletes = options.minTurnCompletes ?? expectedTurns;
  const minAudioTurns = options.minAudioTurns ?? expectedTurns;
  const expectedToolNames = new Set(options.expectedToolNames ?? []);
  const advanceAfterToolResults = new Set(options.advanceAfterToolResults ?? []);

  return new Promise((resolveTest, rejectTest) => {
    const ws = new WebSocket(wsUrl);
    let sentBytes = 0;
    let sentChunks = 0;
    let receivedBytes = 0;
    let receivedChunks = 0;
    let firstAudioMs = 0;
    let audioStartedAt = 0;
    let turnComplete = false;
    let turnCompletes = 0;
    let sentTurns = 0;
    const turnStartReceivedChunks: number[] = [];
    const turnAudioChunks: number[] = [];
    const toolResults: string[] = [];
    const toolResultCounts = new Map<string, number>();
    let lastToolResultReceivedChunks = 0;
    let nextTurnScheduledFor = -1;
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, SELF_TEST_CLIENT);
      }
      if (err) rejectTest(err);
      else {
        resolveTest({
          sentBytes,
          sentChunks,
          receivedBytes,
          receivedChunks,
          firstAudioMs,
          turnComplete,
          turnCompletes,
          expectedTurns,
          turnAudioChunks,
          toolResults,
        });
      }
    };

    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Timed out waiting for Gemini audio response; sent ${sentChunks} chunks/${sentBytes} bytes, received ${receivedChunks} chunks/${receivedBytes} bytes, turns=${turnCompletes}/${minTurnCompletes}, audioTurns=${countAudioTurns()}/${minAudioTurns}, tools=${toolResults.length}/${options.expectedToolResults ?? 0}`,
        ),
      );
    }, options.requireTurnComplete || fixtureNames.length > 1 || (options.expectedToolResults ?? 0) > 0 ? 120_000 : 45_000);

    const sendTurn = async (turnIndex: number) => {
      if (done || turnIndex >= fixtures.length || turnIndex !== sentTurns || ws.readyState !== WebSocket.OPEN) return;
      sentTurns = Math.max(sentTurns, turnIndex + 1);
      if (nextTurnScheduledFor === turnIndex) nextTurnScheduledFor = -1;
      turnStartReceivedChunks[turnIndex] = receivedChunks;
      await sendPcmRealtime(ws, fixtures[turnIndex]!, (bytes) => {
        sentBytes += bytes;
        sentChunks += 1;
      });

      for (let i = 0; i < 75; i++) {
        if (ws.readyState !== WebSocket.OPEN || done) break;
        ws.send(silence, { binary: true });
        sentBytes += silence.byteLength;
        sentChunks += 1;
        await sleep(20);
      }
      if (ws.readyState === WebSocket.OPEN && !done) {
        ws.send(JSON.stringify({ type: 'end_of_audio' }));
      }
    };

    const countAudioTurns = () => turnAudioChunks.filter((count) => count > 0).length;

    const scheduleNextTurn = (delayMs: number) => {
      const turnIndex = sentTurns;
      if (done || turnIndex >= fixtures.length || nextTurnScheduledFor === turnIndex) return;
      nextTurnScheduledFor = turnIndex;
      setTimeout(() => {
        void (async () => {
          try {
            await sendTurn(turnIndex);
          } catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      }, delayMs);
    };

    const maybeFinishAfterTurn = () => {
      const toolsOk =
        toolResults.length >= (options.expectedToolResults ?? 0) &&
        [...expectedToolNames].every((name) => toolResultCounts.has(name));
      const audioOk = receivedBytes > 0 && countAudioTurns() >= minAudioTurns;
      const postToolAudioOk = (options.expectedToolResults ?? 0) > 0
        ? receivedChunks > lastToolResultReceivedChunks
        : true;
      if (!options.requireTurnComplete) {
        const scenarioOk = sentTurns >= fixtures.length && audioOk && toolsOk && postToolAudioOk;
        if (fixtures.length > 1 || (options.expectedToolResults ?? 0) > 0 || minAudioTurns > 1) {
          if (scenarioOk) finish();
        } else if (receivedBytes > 0) {
          finish();
        }
        return;
      }
      const turnsOk = turnCompletes >= minTurnCompletes;
      if (sentTurns >= fixtures.length && turnsOk && audioOk && toolsOk) finish();
    };

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const bytes = rawDataByteLength(data);
      receivedBytes += bytes;
      receivedChunks += 1;
      const activeTurnIndex = Math.max(0, sentTurns - 1);
      turnAudioChunks[activeTurnIndex] = receivedChunks - (turnStartReceivedChunks[activeTurnIndex] ?? 0);
      if (!firstAudioMs) firstAudioMs = Date.now() - audioStartedAt;
      maybeFinishAfterTurn();
    });

    ws.on('error', (err) => finish(err));
    ws.on('close', (code, reason) => {
      if (!done && code !== 1000) {
        finish(new Error(`WebSocket closed before audio response: ${code} ${reason.toString()}`));
      }
    });

    ws.on('open', () => {
      audioStartedAt = Date.now();
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: { type?: string } | undefined;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.type === 'turn_complete') {
        turnComplete = true;
        turnCompletes += 1;
        const completedTurnIndex = turnCompletes - 1;
        turnAudioChunks[completedTurnIndex] = receivedChunks - (turnStartReceivedChunks[completedTurnIndex] ?? 0);
        if (turnCompletes < expectedTurns) {
          scheduleNextTurn(1200);
        } else {
          maybeFinishAfterTurn();
        }
      } else if (msg?.type === 'tool_result') {
        const toolName = (msg as { toolName?: unknown }).toolName;
        if (typeof toolName === 'string') {
          toolResults.push(toolName);
          toolResultCounts.set(toolName, (toolResultCounts.get(toolName) ?? 0) + 1);
          lastToolResultReceivedChunks = receivedChunks;
          if (advanceAfterToolResults.has(toolName)) {
            scheduleNextTurn(options.requireTurnComplete ? 2500 : 7000);
          }
        }
        maybeFinishAfterTurn();
      } else if (msg?.type === 'session_started') {
        void (async () => {
          try {
            await sendTurn(sentTurns);
          } catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      }
    });
  });
}

function rawDataByteLength(data: WebSocket.RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  return Buffer.byteLength(String(data));
}

async function sendPcmRealtime(ws: WebSocket, pcm: Buffer, onChunk: (bytes: number) => void): Promise<void> {
  const frameBytes = 960; // 20ms at 24kHz int16 mono.
  for (let offset = 0; offset < pcm.byteLength; offset += frameBytes) {
    if (ws.readyState !== WebSocket.OPEN) break;
    const frame = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.byteLength));
    ws.send(frame, { binary: true });
    onChunk(frame.byteLength);
    await sleep(20);
  }
}

function streamServerLogs(
  serverCmd: Command,
  onSessionEnded: (event: Record<string, unknown>) => void,
): () => void {
  const controller = new AbortController();
  let buffer = '';

  void (async () => {
    try {
      for await (const log of serverCmd.logs({ signal: controller.signal })) {
        const prefix = log.stream === 'stderr' ? '[sandbox err] ' : '[sandbox] ';
        process.stdout.write(prefix + log.data);

        buffer += log.data;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const markerIndex = line.indexOf(SESSION_ENDED_MARKER);
          if (markerIndex >= 0) {
            const json = line.slice(markerIndex + SESSION_ENDED_MARKER.length).trim();
            try {
              onSessionEnded(JSON.parse(json));
            } catch {
              onSessionEnded({ raw: json });
            }
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error('Server log stream failed:', err instanceof Error ? err.message : err);
      }
    }
  })();

  return () => controller.abort();
}

function readSnapshotCache(): SnapshotCache | undefined {
  if (!existsSync(SNAPSHOT_CACHE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_CACHE_PATH, 'utf-8')) as Partial<SnapshotCache>;
    if (parsed.snapshotId && parsed.dependencySignature && parsed.createdAt) {
      return parsed as SnapshotCache;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function loadEnvFiles(paths: string[]): void {
  for (const envFile of paths) {
    try {
      const content = readFileSync(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    } catch {
      // Optional env file.
    }
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

const invokedAsMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedAsMain) {
  main().catch((err) => {
    console.error('FATAL:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
