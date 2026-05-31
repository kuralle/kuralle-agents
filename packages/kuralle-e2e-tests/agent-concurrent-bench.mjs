#!/usr/bin/env node
/**
 * Concurrency sweep against the Kuralle voice agent over both transports.
 *
 * Spins up N concurrent WS connections per endpoint, each running TURNS turns
 * of (varied PCM utterance + 250ms silence + end_of_audio). Reports success
 * rate, TTFA-from-EOA percentiles across all completed turns, and per-call
 * connect time.
 *
 * Usage:
 *   CONCURRENCY=25 TURNS=2 node agent-concurrent-bench.mjs
 *   # or sweep:
 *   SWEEP=5,25,50,100 TURNS=2 node agent-concurrent-bench.mjs
 *
 * Cost estimate at C=100 T=2: ~600 user-audio seconds + ~400 bot-audio
 * seconds + ~200 Gemini calls. Deepgram: ~$0.20, Gemini Flash: ~$0.05.
 */

import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TURN_FIXTURES = [
  { label: 'hello', file: 'bench_hello.pcm' },
  { label: 'weather', file: 'bench_weather.pcm' },
  { label: 'party-of-four', file: 'flow_restaurant_party_of_four.pcm' },
  { label: 'six-pm', file: 'flow_restaurant_six_pm.pcm' },
  { label: 'goodbye', file: 'bench_goodbye.pcm' },
];
const PCMS = TURN_FIXTURES.map((t) => ({
  ...t, pcm: readFileSync(join(__dirname, 'fixtures', t.file)),
}));

const ENDPOINTS = [
  { name: 'ws@8', url: 'wss://kuralle-voice-agent.fly.dev' },
  { name: 'sockudo', url: 'wss://kuralle-voice-agent-sockudo.fly.dev' },
  { name: 'bun', url: 'wss://kuralle-voice-agent-bun.fly.dev' },
];

const TURNS = Number(process.env.TURNS ?? 2);
const SILENCE_MS = 250;
const FRAME_MS = 20;
const FRAME_BYTES = 960;
const TURN_TIMEOUT_MS = 60000;
const SESSION_TIMEOUT_MS = 180000;
const RAMP_MS = Number(process.env.RAMP_MS ?? 30); // gap between starting calls — avoid thundering herd

const SWEEP = (process.env.SWEEP ?? String(process.env.CONCURRENCY ?? 10))
  .split(',').map((s) => Number(s.trim())).filter(Boolean);

function silence(ms, sampleRate = 24000) {
  return Buffer.alloc(Math.floor((sampleRate * ms) / 1000) * 2);
}

async function sendPaced(ws, pcm) {
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    const end = Math.min(off + FRAME_BYTES, pcm.length);
    if (ws.readyState !== ws.OPEN) return;
    ws.send(pcm.slice(off, end), { binary: true });
    const jitter = (Math.random() * 2 - 1) * 4;
    await new Promise((r) => setTimeout(r, Math.max(1, FRAME_MS + jitter)));
  }
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function runOneCall(callId, url) {
  return new Promise((resolve) => {
    const tCallStart = performance.now();
    const ws = new WebSocket(url);
    let tOpen = 0;
    let sessionStarted = false;
    let currentTurn = null;
    const turns = [];
    const masterTimeout = setTimeout(() => {
      try { ws.terminate(); } catch {}
      resolve({ callId, status: 'session_timeout', tOpenMs: tOpen ? tOpen - tCallStart : null, turns });
    }, SESSION_TIMEOUT_MS);

    async function startTurn(idx) {
      const fixture = PCMS[idx % PCMS.length];
      currentTurn = { idx, label: fixture.label, tStart: performance.now(), tEoa: 0, tFirstAudio: 0 };
      const turnTimeout = setTimeout(() => {
        // mark turn as failed; let session continue
        currentTurn = null;
        turns.push({ idx, label: fixture.label, status: 'turn_timeout' });
      }, TURN_TIMEOUT_MS);
      currentTurn._timeout = turnTimeout;

      await sendPaced(ws, fixture.pcm);
      await sendPaced(ws, silence(SILENCE_MS));
      if (!currentTurn || ws.readyState !== ws.OPEN) return;
      currentTurn.tEoa = performance.now();
      try { ws.send(JSON.stringify({ type: 'end_of_audio' })); } catch {}
    }

    ws.on('open', () => { tOpen = performance.now(); });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (currentTurn && currentTurn.tEoa && !currentTurn.tFirstAudio) {
          currentTurn.tFirstAudio = performance.now();
          clearTimeout(currentTurn._timeout);
          turns.push({
            idx: currentTurn.idx,
            label: currentTurn.label,
            status: 'ok',
            ttfaFromEoaMs: currentTurn.tFirstAudio - currentTurn.tEoa,
          });
          if (currentTurn.idx < TURNS - 1) {
            const nextIdx = currentTurn.idx + 1;
            currentTurn = null;
            setTimeout(() => startTurn(nextIdx).catch(() => {}), 1500);
          } else {
            currentTurn = null;
            clearTimeout(masterTimeout);
            try { ws.close(); } catch {}
            resolve({ callId, status: 'ok', tOpenMs: tOpen - tCallStart, turns });
          }
        }
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session_started' && !sessionStarted) {
          sessionStarted = true;
          startTurn(0).catch(() => {});
        }
      } catch {
        // ignore
      }
    });
    ws.on('error', (err) => {
      clearTimeout(masterTimeout);
      resolve({ callId, status: 'error', error: err.message, tOpenMs: tOpen ? tOpen - tCallStart : null, turns });
    });
    ws.on('close', () => {
      // If session ended before completion
      if (!sessionStarted) {
        clearTimeout(masterTimeout);
        resolve({ callId, status: 'closed_before_session', tOpenMs: tOpen ? tOpen - tCallStart : null, turns });
      }
    });
  });
}

async function runSweepAt(name, url, concurrency) {
  console.log(`\n>>> ${name} @ ${concurrency} concurrent ${url}`);
  const tStart = performance.now();
  const promises = [];
  for (let i = 0; i < concurrency; i++) {
    promises.push(runOneCall(i, url));
    if (RAMP_MS > 0) await new Promise((r) => setTimeout(r, RAMP_MS));
  }
  const results = await Promise.all(promises);
  const elapsedMs = performance.now() - tStart;

  const okCalls = results.filter((r) => r.status === 'ok');
  const failedCalls = results.filter((r) => r.status !== 'ok');
  const okTurns = results.flatMap((r) => r.turns).filter((t) => t.status === 'ok');
  const failedTurns = results.flatMap((r) => r.turns).filter((t) => t.status !== 'ok');
  const ttfaList = okTurns.map((t) => t.ttfaFromEoaMs);
  const connectList = results.filter((r) => r.tOpenMs !== null).map((r) => r.tOpenMs);

  const failureBreakdown = failedCalls.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  const summary = {
    name, url, concurrency, elapsedMs: Math.round(elapsedMs),
    callsOk: okCalls.length, callsFailed: failedCalls.length, callSuccessPct: ((okCalls.length / concurrency) * 100).toFixed(1),
    turnsOk: okTurns.length, turnsFailed: failedTurns.length,
    ttfa: ttfaList.length
      ? {
          mean: Math.round(ttfaList.reduce((s, v) => s + v, 0) / ttfaList.length),
          p50: Math.round(quantile(ttfaList, 0.5)),
          p95: Math.round(quantile(ttfaList, 0.95)),
          p99: Math.round(quantile(ttfaList, 0.99)),
          max: Math.round(Math.max(...ttfaList)),
        }
      : null,
    connect: connectList.length
      ? {
          p50: Math.round(quantile(connectList, 0.5)),
          p95: Math.round(quantile(connectList, 0.95)),
        }
      : null,
    failureBreakdown,
  };

  console.log(`  calls ok/fail: ${summary.callsOk}/${summary.callsFailed} (${summary.callSuccessPct}%)`);
  console.log(`  turns ok/fail: ${summary.turnsOk}/${summary.turnsFailed}`);
  if (summary.ttfa) {
    console.log(`  TTFA-from-EOA: mean=${summary.ttfa.mean}  p50=${summary.ttfa.p50}  p95=${summary.ttfa.p95}  p99=${summary.ttfa.p99}  max=${summary.ttfa.max} ms`);
  }
  if (summary.connect) {
    console.log(`  connect: p50=${summary.connect.p50}  p95=${summary.connect.p95} ms`);
  }
  if (Object.keys(failureBreakdown).length) {
    console.log(`  failures: ${JSON.stringify(failureBreakdown)}`);
  }
  console.log(`  elapsed: ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  return summary;
}

async function main() {
  console.log(`Concurrent voice agent bench   sweep=[${SWEEP.join(',')}]   turns=${TURNS}   ramp=${RAMP_MS}ms`);
  const all = [];
  for (const concurrency of SWEEP) {
    for (const ep of ENDPOINTS) {
      const r = await runSweepAt(ep.name, ep.url, concurrency);
      all.push(r);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  console.log('\n=== Summary ===');
  console.log('concurrency | endpoint | calls-ok | turn-ok | TTFA p50 | TTFA p95 | TTFA p99 | connect p50 | connect p95');
  for (const r of all) {
    console.log(
      `${String(r.concurrency).padEnd(11)} | ${r.name.padEnd(8)} | ${r.callsOk}/${r.concurrency} | ${r.turnsOk}/${r.concurrency * TURNS} | ` +
      `${r.ttfa?.p50 ?? '-'}ms | ${r.ttfa?.p95 ?? '-'}ms | ${r.ttfa?.p99 ?? '-'}ms | ${r.connect?.p50 ?? '-'}ms | ${r.connect?.p95 ?? '-'}ms`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
