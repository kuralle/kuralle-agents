/**
 * Platform Head-to-Head — Same agent, same audio, three deployment platforms.
 *
 * Sends identical PCM audio to Fly.io, Cloudflare Containers, and Vercel Sandbox
 * (or local server) and compares latency, audio quality, and success rate.
 *
 * Usage:
 *   npx tsx packages/kuralle-e2e-tests/tests/platform-head-to-head.ts
 *
 *   # Custom endpoints
 *   FLY_URL=wss://your-fly.fly.dev CF_URL=wss://your-cf.workers.dev LOCAL_URL=ws://127.0.0.1:3000 \
 *     npx tsx packages/kuralle-e2e-tests/tests/platform-head-to-head.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceCollector } from '../harness/trace_collector.js';
import { WsTestClient } from '../harness/ws_client.js';
import { generateSilence } from '../harness/audio_fixtures.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(currentDir, '../fixtures');
const reportPath = join(currentDir, '../../..', 'platform-head-to-head-report.html');

type PlatformConfig = { name: string; url: string; enabled: boolean };

const platforms: PlatformConfig[] = [
  {
    name: 'Fly.io',
    url: process.env.FLY_URL || 'wss://kuralle-voice-agent.fly.dev',
    enabled: !process.env.SKIP_FLY,
  },
  {
    name: 'Cloudflare Containers',
    url: process.env.CF_URL || 'wss://kuralle-voice-agent-cf.mithushancj.workers.dev',
    enabled: !process.env.SKIP_CF,
  },
  {
    name: 'Local',
    url: process.env.LOCAL_URL || '',
    enabled: !!process.env.LOCAL_URL,
  },
];

const ROUNDS = parseInt(process.env.ROUNDS || '3', 10);

type TurnResult = {
  ttftMs: number;
  firstAudioMs: number;
  totalMs: number;
  audioChunks: number;
  audioBytes: number;
  transcript: string;
  pass: boolean;
};

type PlatformResult = {
  name: string;
  url: string;
  rounds: TurnResult[];
  avgTtft: number;
  avgFirstAudio: number;
  avgTotal: number;
  successRate: number;
};

async function runSingleTurn(url: string): Promise<TurnResult> {
  const trace = new TraceCollector();
  const client = new WsTestClient({ url, trace });

  try {
    await client.waitForOpen(15000);
    await client.waitForJsonMessage('session_started', 20000);

    const pcm = readFileSync(join(fixturesDir, 'bench_hello.pcm'));
    trace.startTurn(0, 'hello');
    await client.sendAudioFramesPaced(new Uint8Array(pcm), 960, 20);
    await client.sendAudioFramesPaced(generateSilence(1200), 960, 20);
    client.sendEndOfAudio();

    // Wait for audio
    const start = Date.now();
    while (Date.now() - start < 45000) {
      if (trace.binaryChunks.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 5000));
    trace.endTurn();

    const transcripts = trace
      .getMessages('user_transcription')
      .filter((m): m is { isFinal: true; text: string } => Boolean((m as { isFinal?: boolean }).isFinal));
    const turn = trace.turnLatencies[0];
    const ttft = turn?.timeToFirstTextMs ?? 0;
    const firstAudio = turn?.timeToFirstAudioMs ?? 0;
    const total = turn?.totalTurnMs ?? 0;

    return {
      ttftMs: ttft,
      firstAudioMs: firstAudio,
      totalMs: total,
      audioChunks: trace.binaryChunks.length,
      audioBytes: trace.totalBinaryBytes,
      transcript: transcripts.map((t) => t.text).join(' '),
      pass: trace.binaryChunks.length > 0,
    };
  } catch (err) {
    return {
      ttftMs: 0,
      firstAudioMs: 0,
      totalMs: 0,
      audioChunks: 0,
      audioBytes: 0,
      transcript: '',
      pass: false,
    };
  } finally {
    client.close();
  }
}

function avg(arr: number[]): number {
  return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

function generateHTML(results: PlatformResult[]): string {
  const rows = results.map((r) => `
    <tr>
      <td><strong>${r.name}</strong></td>
      <td>${r.avgTtft}ms</td>
      <td>${r.avgFirstAudio}ms</td>
      <td>${r.avgTotal}ms</td>
      <td>${r.successRate}%</td>
      <td>${r.rounds.length}</td>
    </tr>`).join('');

  const detailRows = results.flatMap((r) =>
    r.rounds.map((t, i) => `
    <tr>
      <td>${r.name}</td>
      <td>Round ${i + 1}</td>
      <td>${t.pass ? 'PASS' : 'FAIL'}</td>
      <td>${t.ttftMs}ms</td>
      <td>${t.firstAudioMs}ms</td>
      <td>${t.totalMs}ms</td>
      <td>${t.audioChunks}</td>
      <td>${t.audioBytes}</td>
    </tr>`)
  ).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Platform Head-to-Head</title>
<style>
  body{font-family:system-ui;background:#0d1117;color:#e6edf3;padding:2rem}
  h1{color:#58a6ff}h2{border-bottom:1px solid #30363d;padding-bottom:.5rem;margin-top:2rem}
  table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.85rem}
  th,td{padding:10px 14px;border:1px solid #30363d;text-align:left}
  th{background:#1c2128;color:#8b949e;text-transform:uppercase;font-size:.75rem}
  td{background:#161b22}tr:hover td{background:#1c2128}
  .pass{color:#3fb950}.fail{color:#f85149}
  footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #30363d;font-size:.75rem;color:#8b949e}
</style></head><body>
<h1>Platform Head-to-Head — Voice Agent Benchmark</h1>
<p style="color:#8b949e">Same agent (Kuralle ecommerce, Deepgram STT/TTS direct) &bull; Same audio (bench_hello.pcm) &bull; ${ROUNDS} rounds each &bull; ${new Date().toISOString()}</p>
<h2>Summary</h2>
<table><thead><tr><th>Platform</th><th>Avg TTFT</th><th>Avg First Audio</th><th>Avg Total</th><th>Success</th><th>Rounds</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Per-Round Detail</h2>
<table><thead><tr><th>Platform</th><th>Round</th><th>Status</th><th>TTFT</th><th>First Audio</th><th>Total</th><th>Chunks</th><th>Bytes</th></tr></thead><tbody>${detailRows}</tbody></table>
<footer>Generated by platform-head-to-head.ts</footer>
</body></html>`;
}

async function main() {
  const active = platforms.filter((p) => p.enabled);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Platform Head-to-Head — Voice Agent Benchmark');
  console.log(`  Rounds: ${ROUNDS} per platform`);
  console.log(`  Platforms: ${active.map((p) => p.name).join(', ')}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results: PlatformResult[] = [];

  for (const platform of active) {
    console.log(`── ${platform.name} (${platform.url}) ──`);
    const rounds: TurnResult[] = [];

    for (let i = 0; i < ROUNDS; i++) {
      console.log(`  Round ${i + 1}/${ROUNDS}...`);
      const result = await runSingleTurn(platform.url);
      rounds.push(result);
      console.log(`    ${result.pass ? '✓' : '✗'} ttft=${result.ttftMs}ms audio=${result.firstAudioMs}ms total=${result.totalMs}ms chunks=${result.audioChunks}`);
      // Brief pause between rounds
      if (i < ROUNDS - 1) await new Promise((r) => setTimeout(r, 2000));
    }

    const successful = rounds.filter((r) => r.pass);
    results.push({
      name: platform.name,
      url: platform.url,
      rounds,
      avgTtft: avg(successful.map((r) => r.ttftMs)),
      avgFirstAudio: avg(successful.map((r) => r.firstAudioMs)),
      avgTotal: avg(successful.map((r) => r.totalMs)),
      successRate: Math.round((successful.length / rounds.length) * 100),
    });
    console.log();
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log();
  console.log(`  ${'Platform'.padEnd(25)} ${'Avg TTFT'.padEnd(12)} ${'Avg Audio'.padEnd(12)} ${'Avg Total'.padEnd(12)} Success`);
  console.log(`  ${'─'.repeat(25)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(8)}`);

  for (const r of results) {
    console.log(`  ${r.name.padEnd(25)} ${String(r.avgTtft + 'ms').padEnd(12)} ${String(r.avgFirstAudio + 'ms').padEnd(12)} ${String(r.avgTotal + 'ms').padEnd(12)} ${r.successRate}%`);
  }

  // Generate report
  writeFileSync(reportPath, generateHTML(results));
  console.log(`\n  Report: ${reportPath}`);

  try {
    const { execSync } = await import('node:child_process');
    execSync(`open "${reportPath}"`, { stdio: 'ignore' });
  } catch { /* ignore */ }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
