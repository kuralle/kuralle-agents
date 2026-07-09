#!/usr/bin/env npx tsx
/**
 * Voice Agent Load Test — Hardware Benchmark, Latency, and Stress Test.
 *
 * Three test modes matching the SIP load test report format:
 *   1. Hardware benchmark — scale concurrent calls from 5 to N
 *   2. Latency test — per-call timing breakdown (connect, first response, total)
 *   3. Stress test — find max concurrency at ≥90% success rate
 *
 * Usage:
 *   # Against Fly deployment
 *   npx tsx packages/e2e-tests/tests/voice-load-test.ts wss://kuralle-voice-agent.fly.dev
 *
 *   # Against local server
 *   npx tsx packages/e2e-tests/tests/voice-load-test.ts ws://127.0.0.1:3000
 *
 *   # With custom max concurrency
 *   MAX_CONCURRENCY=30 npx tsx packages/e2e-tests/tests/voice-load-test.ts wss://kuralle-voice-agent.fly.dev
 *
 * Generates: voice-load-test-report.html
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(currentDir, '../fixtures');
const reportPath = join(currentDir, '../../..', 'voice-load-test-report.html');

const TARGET = process.argv[2] || 'wss://kuralle-voice-agent.fly.dev';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '60', 10);
const STEP = parseInt(process.env.STEP || '5', 10);
const AUDIO_DURATION_S = parseFloat(process.env.AUDIO_DURATION || '5.0');
const CALL_TIMEOUT_MS = 30000;

// Load PCM fixture
let pcmFixture: Buffer;
try {
  pcmFixture = readFileSync(join(fixturesDir, 'bench_hello.pcm'));
} catch {
  // Generate synthetic audio if no fixture
  const samples = Math.floor(24000 * AUDIO_DURATION_S);
  const buf = Buffer.alloc(samples * 2); // 16-bit PCM
  for (let i = 0; i < samples; i++) {
    const val = Math.floor(Math.sin(2 * Math.PI * 440 * i / 24000) * 3000);
    buf.writeInt16LE(val, i * 2);
  }
  pcmFixture = buf;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type CallResult = {
  success: boolean;
  connectMs: number;
  firstResponseMs: number;
  totalMs: number;
  audioChunks: number;
  audioBytes: number;
  error?: string;
};

type RoundResult = {
  concurrency: number;
  total: number;
  success: number;
  failed: number;
  rate: number;
  avgTime: number;
  p95Time: number;
  avgConnect: number;
  maxConnect: number;
  avgFirstResponse: number;
  maxFirstResponse: number;
  elapsed: number;
  calls: CallResult[];
};

// ─── Single call ──────────────────────────────────────────────────────────────

function runSingleCall(url: string): Promise<CallResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let connectTime = 0;
    let firstResponseTime = 0;
    let audioChunks = 0;
    let audioBytes = 0;
    let sessionStarted = false;
    let gotFirstResponse = false;
    let ended = false;

    const finish = (success: boolean, error?: string) => {
      if (ended) return;
      ended = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve({
        success,
        connectMs: connectTime,
        firstResponseMs: firstResponseTime,
        totalMs: Date.now() - startTime,
        audioChunks,
        audioBytes,
        error,
      });
    };

    const timeout = setTimeout(() => finish(false, 'timeout'), CALL_TIMEOUT_MS);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      clearTimeout(timeout);
      resolve({
        success: false,
        connectMs: 0,
        firstResponseMs: 0,
        totalMs: Date.now() - startTime,
        audioChunks: 0,
        audioBytes: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
      connectTime = Date.now() - startTime;
    });

    ws.on('message', (data: Buffer | ArrayBuffer, isBinary: boolean) => {
      if (isBinary) {
        audioChunks++;
        audioBytes += data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
        if (!gotFirstResponse) {
          gotFirstResponse = true;
          firstResponseTime = Date.now() - startTime;
        }
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session_started' && !sessionStarted) {
          sessionStarted = true;
          // Send audio paced
          sendAudio(ws, pcmFixture).then(() => {
            // Send silence + end_of_audio
            const silence = Buffer.alloc(24000 * 2); // 0.5s silence
            sendAudio(ws, silence).then(() => {
              try {
                ws.send(JSON.stringify({ type: 'end_of_audio' }));
              } catch { /* ignore */ }
              // Wait for audio response — cascaded pipeline takes ~6s for first audio
              setTimeout(() => {
                clearTimeout(timeout);
                finish(audioChunks > 0, audioChunks === 0 ? 'no_audio_response' : undefined);
              }, 20000);
            });
          });
        }
      } catch { /* non-JSON */ }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      finish(false, err.message);
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (!ended) finish(audioChunks > 0, audioChunks === 0 ? 'ws_closed_early' : undefined);
    });
  });
}

async function sendAudio(ws: WebSocket, pcm: Buffer): Promise<void> {
  const frameSize = 960; // 20ms at 24kHz int16
  for (let offset = 0; offset < pcm.length; offset += frameSize) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const chunk = pcm.subarray(offset, Math.min(offset + frameSize, pcm.length));
    ws.send(chunk);
    // Pace at real-time speed (~20ms per frame)
    await new Promise((r) => setTimeout(r, 18));
  }
}

// ─── Run N concurrent calls ──────────────────────────────────────────────────

async function runRound(concurrency: number, url: string): Promise<RoundResult> {
  const roundStart = Date.now();

  const promises = Array.from({ length: concurrency }, () => runSingleCall(url));
  const calls = await Promise.all(promises);

  const elapsed = (Date.now() - roundStart) / 1000;
  const successful = calls.filter((c) => c.success);
  const failed = calls.filter((c) => !c.success);

  const times = successful.map((c) => c.totalMs / 1000).sort((a, b) => a - b);
  const connects = calls.map((c) => c.connectMs / 1000);
  const firstResponses = successful.map((c) => c.firstResponseMs / 1000);

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const p95 = (arr: number[]) => arr.length ? arr[Math.floor(arr.length * 0.95)] ?? arr[arr.length - 1]! : 0;
  const max = (arr: number[]) => arr.length ? Math.max(...arr) : 0;

  return {
    concurrency,
    total: calls.length,
    success: successful.length,
    failed: failed.length,
    rate: calls.length ? (successful.length / calls.length) * 100 : 0,
    avgTime: avg(times),
    p95Time: p95(times),
    avgConnect: avg(connects),
    maxConnect: max(connects),
    avgFirstResponse: avg(firstResponses),
    maxFirstResponse: max(firstResponses),
    elapsed,
    calls,
  };
}

// ─── Generate HTML report ─────────────────────────────────────────────────────

function generateReport(results: RoundResult[], target: string, testDate: string): string {
  const peakConcurrency = [...results].reverse().find((r) => r.rate >= 90)?.concurrency ?? 0;

  const roundRows = results.map((r) => `
    <tr>
      <td>${r.concurrency}</td>
      <td>${r.total}</td>
      <td>${r.success}</td>
      <td>${r.failed}</td>
      <td style="color:${r.rate >= 90 ? '#3fb950' : '#f85149'}">${r.rate.toFixed(1)}%</td>
      <td>${r.avgTime.toFixed(2)}s</td>
      <td>${r.p95Time.toFixed(2)}s</td>
      <td>${r.avgConnect.toFixed(2)}s</td>
      <td>${r.elapsed.toFixed(1)}s</td>
    </tr>`).join('\n');

  const detailSections = results.map((r) => {
    const times = r.calls.filter(c => c.success).map(c => c.totalMs / 1000).sort((a, b) => a - b);
    const min = times.length ? times[0]!.toFixed(2) : '—';
    const maxT = times.length ? times[times.length - 1]!.toFixed(2) : '—';

    return `
    <h3>Concurrency ${r.concurrency} — <span style="color:${r.rate >= 90 ? '#3fb950' : '#f85149'}">${r.rate.toFixed(1)}%</span> (${r.success}/${r.total} succeeded)</h3>
    <pre>Call time: avg=${r.avgTime.toFixed(2)}s p95=${r.p95Time.toFixed(2)}s min=${min}s max=${maxT}s
Connect: avg=${r.avgConnect.toFixed(2)}s max=${r.maxConnect.toFixed(2)}s
First response: avg=${r.avgFirstResponse.toFixed(2)}s max=${r.maxFirstResponse.toFixed(2)}s
Total elapsed: ${r.elapsed.toFixed(1)}s</pre>
    ${r.failed > 0 ? `<p style="color:#f85149;font-size:0.85rem">Failures: ${r.calls.filter(c => !c.success).map(c => c.error || 'unknown').join(', ')}</p>` : ''}`;
  }).join('\n');

  // Chart data
  const labels = results.map((r) => r.concurrency);
  const avgData = results.map((r) => r.avgTime.toFixed(2));
  const p95Data = results.map((r) => r.p95Time.toFixed(2));
  const rateData = results.map((r) => r.rate.toFixed(1));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Voice Agent Load Test Report</title>
<style>
  :root { --bg:#0d1117; --surface:#161b22; --surface2:#1c2128; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#58a6ff; --green:#3fb950; --red:#f85149; --yellow:#d29922; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); line-height:1.6; padding:2rem; }
  h1 { font-size:1.8rem; color:var(--accent); margin-bottom:0.3rem; }
  h2 { font-size:1.3rem; margin:2rem 0 1rem; padding-bottom:0.5rem; border-bottom:1px solid var(--border); }
  h3 { font-size:1rem; margin:1.5rem 0 0.5rem; color:var(--muted); }
  .subtitle { color:var(--muted); font-size:0.9rem; margin-bottom:2rem; }
  table { width:100%; border-collapse:collapse; margin:1rem 0; font-size:0.85rem; }
  th,td { padding:10px 14px; text-align:left; border:1px solid var(--border); }
  th { background:var(--surface2); font-weight:600; color:var(--muted); font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px; }
  td { background:var(--surface); }
  tr:hover td { background:var(--surface2); }
  .info-table { max-width:600px; }
  .info-table td:first-child { font-weight:600; width:250px; }
  pre { background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:0.8rem 1rem; font-size:0.85rem; color:var(--muted); overflow-x:auto; margin:0.5rem 0; }
  .chart-container { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:1.5rem; margin:1rem 0; }
  canvas { max-width:100%; }
  footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--border); font-size:0.75rem; color:var(--muted); }
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>
<body>

<h1>Voice Agent Load Test Report</h1>
<p class="subtitle">Kuralle Voice Agent — Concurrent WebSocket Load Test</p>

<table class="info-table">
  <tr><td>Target</td><td>${target}</td></tr>
  <tr><td>Date / Time</td><td>${testDate}</td></tr>
  <tr><td>Audio per call</td><td>${(pcmFixture.length / (24000 * 2)).toFixed(1)}s (PCM int16 24 kHz mono)</td></tr>
  <tr><td>Total rounds</td><td>${results.length}</td></tr>
  <tr><td>Max concurrency tested</td><td>${results[results.length - 1]?.concurrency ?? 0}</td></tr>
  <tr><td>Peak concurrency (≥90% success)</td><td>${peakConcurrency}</td></tr>
</table>

<h2>Round Results</h2>
<table>
  <thead>
    <tr>
      <th>Concurrency</th><th>Total</th><th>Success</th><th>Failed</th>
      <th>Rate %</th><th>Avg Time</th><th>P95 Time</th><th>Avg Connect</th><th>Elapsed</th>
    </tr>
  </thead>
  <tbody>${roundRows}</tbody>
</table>

<h2>Success Rate vs Concurrency</h2>
<div class="chart-container">
  <canvas id="rateChart" height="80"></canvas>
</div>

<h2>Average Call Duration vs Concurrency</h2>
<div class="chart-container">
  <canvas id="latencyChart" height="80"></canvas>
</div>

<h2>Per-Round Detail</h2>
${detailSections}

<footer>Generated by kuralle-voice-agent load test &middot; ${testDate}</footer>

<script>
const labels = ${JSON.stringify(labels)};
const chartDefaults = { responsive: true, plugins: { legend: { labels: { color: '#8b949e' } } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' }, title: { display: true, text: 'Concurrent Calls', color: '#8b949e' } }, y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } } };

new Chart(document.getElementById('rateChart'), {
  type: 'bar',
  data: { labels, datasets: [{ label: 'Success Rate %', data: ${JSON.stringify(rateData)}, backgroundColor: 'rgba(88,166,255,0.7)', borderColor: '#58a6ff', borderWidth: 1 }] },
  options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min: 0, max: 100 } }, plugins: { ...chartDefaults.plugins, annotation: { annotations: { line90: { type: 'line', yMin: 90, yMax: 90, borderColor: '#3fb950', borderDash: [5,5], label: { display: true, content: '90%', color: '#3fb950' } } } } } }
});

new Chart(document.getElementById('latencyChart'), {
  type: 'line',
  data: { labels, datasets: [
    { label: 'Avg', data: ${JSON.stringify(avgData)}, borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.1)', tension: 0.3 },
    { label: 'P95', data: ${JSON.stringify(p95Data)}, borderColor: '#d29922', backgroundColor: 'rgba(210,153,34,0.1)', borderDash: [5,5], tension: 0.3 },
  ]},
  options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, title: { display: true, text: 'Seconds', color: '#8b949e' } } } }
});
</script>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const testDate = new Date().toISOString().replace('T', ' ').slice(0, 19);

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        Voice Agent Load Test — Kuralle                     ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Target:          ${TARGET}`);
  console.log(`║  Max Concurrency: ${MAX_CONCURRENCY}`);
  console.log(`║  Step:            ${STEP}`);
  console.log(`║  Audio:           ${(pcmFixture.length / (24000 * 2)).toFixed(1)}s PCM 24kHz int16 mono`);
  console.log(`║  Call Timeout:    ${CALL_TIMEOUT_MS / 1000}s`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const results: RoundResult[] = [];

  for (let c = STEP; c <= MAX_CONCURRENCY; c += STEP) {
    console.log(`── Round: ${c} concurrent calls ──`);
    const result = await runRound(c, TARGET);
    results.push(result);

    const status = result.rate >= 90 ? '✓' : '✗';
    console.log(
      `  ${status} ${result.success}/${result.total} (${result.rate.toFixed(1)}%) ` +
      `avg=${result.avgTime.toFixed(2)}s p95=${result.p95Time.toFixed(2)}s ` +
      `connect=${result.avgConnect.toFixed(2)}s elapsed=${result.elapsed.toFixed(1)}s`,
    );

    if (result.failed > 0) {
      const errors = result.calls.filter((c) => !c.success).map((c) => c.error || 'unknown');
      console.log(`  Failures: ${errors.join(', ')}`);
    }

    // If success rate drops below 50%, stop early
    if (result.rate < 50 && c > STEP) {
      console.log(`\n  Stopping early: success rate dropped below 50% at ${c} concurrent`);
      break;
    }

    // Brief pause between rounds
    await new Promise((r) => setTimeout(r, 2000));
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  const peakConcurrency = [...results].reverse().find((r) => r.rate >= 90)?.concurrency ?? 0;

  console.log('\n' + '═'.repeat(60));
  console.log('  SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Peak concurrency (≥90%): ${peakConcurrency}`);
  console.log(`  Rounds tested:          ${results.length}`);

  if (results.length > 0) {
    const allAvg = results.map((r) => r.avgTime);
    console.log(`  Avg call time range:    ${Math.min(...allAvg).toFixed(2)}s – ${Math.max(...allAvg).toFixed(2)}s`);
  }

  // ─── Generate report ─────────────────────────────────────────────────────
  const html = generateReport(results, TARGET, testDate);
  writeFileSync(reportPath, html);
  console.log(`\n  Report: ${reportPath}`);

  // Try to open
  try {
    const { execSync } = await import('node:child_process');
    execSync(`open "${reportPath}"`, { stdio: 'ignore' });
  } catch { /* ignore */ }

  const allPass = results.every((r) => r.rate >= 90);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
