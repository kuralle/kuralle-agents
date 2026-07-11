/**
 * Shared harness for Cloudflare voice-agent smoke tests.
 *
 * Mirrors `fly-smoke-test.ts` but adapts to the voice-protocol (`welcome`,
 * `start_call`, `transcript`, `audio_config`, ...) and adds two things the
 * Node smoke didn't need:
 *
 *   1. URL routing: CF's `agents` SDK exposes Durable Objects under the path
 *      `/agents/<class-in-kebab-case>/<instance-name>`. We derive the path
 *      from the worker name and instance id rather than hardcoding.
 *
 *   2. Optional `wrangler tail` capture in parallel so the harness prints a
 *      live cross-reference of server-side logs alongside the client-side
 *      trace. Saves the round-trip of "smoke failed, now let me open tail
 *      and re-run" that bit us through Wave 3.
 *
 * Usage (programmatic):
 *   runCfVoiceSmoke({
 *     wsUrl:       "wss://cf-voice-realtime-gemini.mithushancj.workers.dev",
 *     instancePath: "/agents/cfvoicerealtimegemini/smoke-test",
 *     pcmFixture:   "bench_hello.pcm",
 *     tailWorker:   "cf-voice-realtime-gemini",
 *     accountId:    "<your-cloudflare-account-id>",
 *     tailDurationMs: 45_000,
 *     audioInputRate: 16000,    // Gemini expects 16kHz; fixtures are 24kHz
 *   });
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TraceCollector } from '../harness/trace_collector.js';
import { WsTestClient } from '../harness/ws_client.js';
import { generateSilence } from '../harness/audio_fixtures.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(currentDir, '../fixtures');

export interface CfSmokeOptions {
  /** Worker base URL, e.g. `wss://cf-voice-realtime-gemini.mithushancj.workers.dev`. */
  wsUrl: string;
  /** Path under the worker, e.g. `/agents/cfvoicerealtimegemini/smoke-test`. */
  instancePath: string;
  /** PCM fixture filename under `packages/e2e-tests/fixtures`. */
  pcmFixture: string;
  /** Optional: `wrangler tail` worker name. If set, tails in parallel. */
  tailWorker?: string;
  /** CF account id for wrangler. */
  accountId?: string;
  /** How long to wait overall before giving up. Default 60s. */
  tailDurationMs?: number;
  /** Input audio rate — fixtures are 24kHz; Gemini needs 16kHz. Default 24000. */
  audioInputRate?: number;
  /** Fixture source rate (recorded). Default 24000. */
  audioFixtureRate?: number;
  /** Where to write the captured `wrangler tail` JSON log. Optional. */
  tailLogPath?: string;
  /** Human label for the run (printed in banners). */
  label?: string;
}

export interface CfSmokeResult {
  connected: boolean;
  welcome: boolean;
  startCallAccepted: boolean;
  audioSent: boolean;
  audioReceivedBytes: number;
  audioChunks: number;
  transcripts: Array<{ role: string; text: string }>;
  errorFrames: Array<Record<string, unknown>>;
  pass: boolean;
  tailLogPath?: string;
}

/**
 * Linear-interpolation downsampler for PCM16 LE. Used when the fixture
 * sample rate doesn't match what the provider expects — Gemini wants 16kHz,
 * our fixtures are 24kHz, so we decimate 3:2 here.
 */
function resamplePcm16(
  input: Uint8Array,
  fromRate: number,
  toRate: number,
): Uint8Array {
  if (fromRate === toRate) return input;
  const inI16 = new Int16Array(input.buffer, input.byteOffset, input.byteLength / 2);
  const ratio = fromRate / toRate;
  const outLen = Math.floor(inI16.length / ratio);
  const outI16 = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const idx = Math.floor(src);
    const frac = src - idx;
    const a = inI16[idx] ?? 0;
    const b = inI16[Math.min(idx + 1, inI16.length - 1)] ?? a;
    outI16[i] = Math.round(a * (1 - frac) + b * frac);
  }
  return new Uint8Array(outI16.buffer, 0, outI16.byteLength);
}

function spawnTail(
  worker: string,
  accountId: string | undefined,
  logPath: string | undefined,
): { proc: ChildProcess; lines: string[] } {
  const env = { ...process.env } as Record<string, string>;
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  const args = ['tail', worker, '--format', 'json'];
  const proc = spawn('wrangler', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lines.push(line);
    }
  });
  proc.stderr?.on('data', () => {
    /* wrangler prints auth/version spam on stderr; ignore */
  });
  proc.on('error', (err) => {
    console.warn('  [tail] spawn error:', err.message);
  });
  if (logPath) {
    proc.on('exit', () => {
      try {
        writeFileSync(logPath, lines.join('\n'));
      } catch {
        /* best-effort */
      }
    });
  }
  return { proc, lines };
}

export async function runCfVoiceSmoke(options: CfSmokeOptions): Promise<CfSmokeResult> {
  const label = options.label ?? options.tailWorker ?? 'cf-smoke';
  const tailDurationMs = options.tailDurationMs ?? 60_000;
  const audioInputRate = options.audioInputRate ?? 24000;
  const audioFixtureRate = options.audioFixtureRate ?? 24000;
  const wsFullUrl = `${options.wsUrl.replace(/\/$/, '')}${options.instancePath}`;

  console.log('═'.repeat(66));
  console.log(`  CF VOICE SMOKE — ${label}`);
  console.log(`  WS URL: ${wsFullUrl}`);
  console.log(`  Fixture: ${options.pcmFixture} (${audioFixtureRate}Hz → ${audioInputRate}Hz)`);
  console.log('═'.repeat(66));

  // ── 1. Start wrangler tail in parallel (optional) ────────────────────────
  let tail: { proc: ChildProcess; lines: string[] } | undefined;
  if (options.tailWorker) {
    tail = spawnTail(options.tailWorker, options.accountId, options.tailLogPath);
    // Give tail a moment to attach before we generate traffic. Tail needs
    // ~3s typically to complete the handshake with the wrangler API.
    await new Promise((r) => setTimeout(r, 4_000));
    console.log(`  [tail] wrangler tail attached to ${options.tailWorker}`);
  }

  // ── 2. Open WS ───────────────────────────────────────────────────────────
  const trace = new TraceCollector();
  const client = new WsTestClient({ url: wsFullUrl, trace });

  const result: CfSmokeResult = {
    connected: false,
    welcome: false,
    startCallAccepted: false,
    audioSent: false,
    audioReceivedBytes: 0,
    audioChunks: 0,
    transcripts: [],
    errorFrames: [],
    pass: false,
    tailLogPath: options.tailLogPath,
  };

  try {
    await client.waitForOpen(15_000);
    result.connected = true;
    console.log('  [client] WS open');

    // ── 3. Await welcome frame ─────────────────────────────────────────────
    const welcome = await client.waitForJsonMessage('welcome', 10_000);
    result.welcome = true;
    console.log('  [client] welcome:', JSON.stringify(welcome));

    // ── 4. Send start_call ─────────────────────────────────────────────────
    client.ws.send(JSON.stringify({ type: 'start_call' }));
    console.log('  [client] → start_call');

    const audioCfg = await client.waitForJsonMessage('audio_config', 20_000);
    result.startCallAccepted = true;
    console.log('  [client] audio_config:', JSON.stringify(audioCfg));

    // ── 5. Send the fixture audio + trailing silence ───────────────────────
    const fixturePath = join(fixturesDir, options.pcmFixture);
    const pcmRaw = new Uint8Array(readFileSync(fixturePath));
    const pcm = resamplePcm16(pcmRaw, audioFixtureRate, audioInputRate);
    trace.startTurn(0, 'smoke');
    // Frame size: 20ms @ <rate> = rate * 2bytes * 0.02 samples.
    const frameSize = Math.floor(audioInputRate * 2 * 0.02);
    await client.sendAudioFramesPaced(pcm, frameSize, 20);
    await client.sendAudioFramesPaced(
      generateSilence(1500, audioInputRate),
      frameSize,
      20,
    );
    result.audioSent = true;
    console.log(
      `  [client] audio sent: fixture=${pcm.length}B silence=${audioInputRate * 2 * 1.5}B`,
    );

    // ── 6. Wait for audio response OR transcript OR timeout ────────────────
    const deadline = Date.now() + tailDurationMs;
    while (Date.now() < deadline) {
      if (trace.binaryChunks.length > 0 && trace.jsonMessages.some((m) => m.type === 'transcript')) {
        break;
      }
      // Early-exit on error
      if (trace.jsonMessages.some((m) => m.type === 'error')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // Grace period for any tail-end chunks.
    await new Promise((r) => setTimeout(r, 3_000));
    trace.endTurn();

    result.audioChunks = trace.binaryChunks.length;
    result.audioReceivedBytes = trace.totalBinaryBytes;
    result.transcripts = trace.getMessages('transcript').map((m) => ({
      role: String(m.role ?? 'unknown'),
      text: String(m.text ?? ''),
    }));
    result.errorFrames = trace.jsonMessages
      .filter((m) => m.type === 'error')
      .map((m) => m as Record<string, unknown>);
  } catch (err) {
    console.error('  [client] error:', err instanceof Error ? err.message : String(err));
  } finally {
    try {
      client.close();
    } catch {
      /* ignore */
    }
    if (tail) {
      tail.proc.kill('SIGINT');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ── 7. Print tail correlation ──────────────────────────────────────────
  if (tail && tail.lines.length > 0) {
    console.log('');
    console.log('─── wrangler tail (server-side) ───');
    // Print everything — filtering bit us when the server threw before any
    // of our namespaced logs fired. Cap the total lines to avoid flooding.
    const shown = tail.lines.slice(0, 120);
    for (const line of shown) {
      try {
        const obj = JSON.parse(line) as {
          logs?: Array<{ message?: unknown[]; level?: string }>;
          exceptions?: Array<{ name?: string; message?: string; stack?: string; timestamp?: number }>;
          outcome?: string;
          event?: unknown;
        };
        if (obj.exceptions && obj.exceptions.length > 0) {
          for (const ex of obj.exceptions) {
            console.log(`  ✗ EXCEPTION ${ex.name ?? ''}: ${ex.message ?? ''}`);
            if (ex.stack) {
              const head = ex.stack.split('\n').slice(0, 5).join('\n    ');
              console.log(`    ${head}`);
            }
          }
        }
        for (const log of obj.logs ?? []) {
          const msg = (log.message ?? [])
            .map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
            .join(' ');
          if (msg.trim()) {
            const prefix = log.level === 'error' ? '  ✗' : '  ·';
            console.log(`${prefix} ${msg}`);
          }
        }
      } catch {
        console.log(`  ${line.slice(0, 240)}`);
      }
    }
    if (tail.lines.length > shown.length) {
      console.log(`  … ${tail.lines.length - shown.length} more lines`);
    }
  } else if (tail) {
    console.log('');
    console.log('─── wrangler tail: (no lines captured) ───');
  }

  // ── 8. Summary ─────────────────────────────────────────────────────────
  console.log('');
  console.log('─── Summary ───');
  console.log(`  WS connect:        ${result.connected ? '✓' : '✗'}`);
  console.log(`  welcome frame:     ${result.welcome ? '✓' : '✗'}`);
  console.log(`  start_call ack:    ${result.startCallAccepted ? '✓' : '✗'}`);
  console.log(`  audio sent:        ${result.audioSent ? '✓' : '✗'}`);
  console.log(`  audio chunks:      ${result.audioChunks} (${result.audioReceivedBytes}B)`);
  console.log(`  transcripts:       ${result.transcripts.length}`);
  for (const t of result.transcripts.slice(0, 4)) {
    console.log(`    ${t.role}: "${t.text}"`);
  }
  if (result.errorFrames.length > 0) {
    console.log(`  errors: ${JSON.stringify(result.errorFrames)}`);
  }

  result.pass =
    result.connected &&
    result.welcome &&
    result.startCallAccepted &&
    result.audioSent &&
    result.audioChunks > 0 &&
    result.audioReceivedBytes > 100 &&
    result.errorFrames.length === 0;

  console.log('');
  console.log(`  RESULT: ${result.pass ? '✓ PASS' : '✗ FAIL'}`);
  return result;
}
