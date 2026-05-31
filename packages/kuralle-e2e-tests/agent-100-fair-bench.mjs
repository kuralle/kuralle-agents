#!/usr/bin/env node
/**
 * Rate-limit-aware sequential 100-concurrent run. Each transport gets a
 * clean 5-minute gap to let Deepgram's per-account concurrent-WS quota
 * recover before the next run, removing the confound from the back-to-back
 * test.
 *
 * Total wall clock: ~25 min (3 runs × ~3 min + 2 × 5-min gaps).
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ENDPOINTS_ORDERED = [
  { name: 'ws@8', url: 'wss://kuralle-voice-agent.fly.dev' },
  { name: 'sockudo', url: 'wss://kuralle-voice-agent-sockudo.fly.dev' },
  { name: 'bun', url: 'wss://kuralle-voice-agent-bun.fly.dev' },
];

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min between each transport

async function runOne(name, url) {
  console.log(`\n=== ${name} @ 100 concurrent — START at ${new Date().toISOString()} ===`);
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [join(__dirname, 'agent-concurrent-bench.mjs')],
      {
        env: {
          ...process.env,
          SWEEP: '100',
          TURNS: '2',
          RAMP_MS: '50',
          // Filter ENDPOINTS to just this one via env hack — the agent-concurrent-bench
          // hardcodes the list, so we'll spawn it 3 times with a different URL each time
          // by using a tiny inline override.
          ARIA_BENCH_FILTER: name,
        },
        stdio: 'inherit',
      },
    );
    child.on('exit', () => resolve());
  });
}

// Better: write a single-endpoint runner inline rather than wrestle with env.
async function runOneInline(name, url) {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      ['-e', `
        process.env.SWEEP = '100';
        process.env.TURNS = '2';
        process.env.RAMP_MS = '50';
        const orig = (globalThis.fetch || (() => {}));  // no-op
        // Override the ENDPOINTS to just this one
        import('./agent-concurrent-bench.mjs');
      `].concat([]),
      { cwd: __dirname, stdio: 'inherit' },
    );
    child.on('exit', () => resolve());
  });
}

// Simplest: copy the bench logic here, parameterized by endpoint.
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const TURN_FIXTURES = [
  { label: 'hello', file: 'bench_hello.pcm' },
  { label: 'weather', file: 'bench_weather.pcm' },
  { label: 'party-of-four', file: 'flow_restaurant_party_of_four.pcm' },
  { label: 'six-pm', file: 'flow_restaurant_six_pm.pcm' },
  { label: 'goodbye', file: 'bench_goodbye.pcm' },
];
const PCMS = TURN_FIXTURES.map((t) => ({ ...t, pcm: readFileSync(join(__dirname, 'fixtures', t.file)) }));

const TURNS = 2;
const SILENCE_MS = 250;
const FRAME_MS = 20;
const FRAME_BYTES = 960;
const TURN_TIMEOUT_MS = 60000;
const SESSION_TIMEOUT_MS = 180000;
const RAMP_MS = 50;
const CONCURRENCY = 100;

function silenceBuf(ms, sampleRate = 24000) { return Buffer.alloc(Math.floor((sampleRate * ms) / 1000) * 2); }
function quantile(arr, q) { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); const p = (s.length-1)*q; const b = Math.floor(p); const r = p - b; return s[b+1] !== undefined ? s[b]+r*(s[b+1]-s[b]) : s[b]; }

async function sendPaced(ws, pcm) {
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(pcm.slice(off, Math.min(off + FRAME_BYTES, pcm.length)), { binary: true });
    const j = (Math.random() * 2 - 1) * 4;
    await sleep(Math.max(1, FRAME_MS + j));
  }
}

function runOneCall(callId, url) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const ws = new WebSocket(url);
    let tOpen = 0, sessionStarted = false, currentTurn = null;
    const turns = [];
    const masterTimeout = setTimeout(() => { try { ws.terminate(); } catch {}; resolve({ callId, status: 'session_timeout', tOpenMs: tOpen ? tOpen - t0 : null, turns }); }, SESSION_TIMEOUT_MS);

    async function startTurn(idx) {
      const fx = PCMS[idx % PCMS.length];
      currentTurn = { idx, label: fx.label, tStart: performance.now(), tEoa: 0, tFirstAudio: 0 };
      const tt = setTimeout(() => { currentTurn = null; turns.push({ idx, label: fx.label, status: 'turn_timeout' }); }, TURN_TIMEOUT_MS);
      currentTurn._timeout = tt;
      await sendPaced(ws, fx.pcm);
      await sendPaced(ws, silenceBuf(SILENCE_MS));
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
          turns.push({ idx: currentTurn.idx, status: 'ok', ttfaFromEoaMs: currentTurn.tFirstAudio - currentTurn.tEoa });
          if (currentTurn.idx < TURNS - 1) {
            const next = currentTurn.idx + 1;
            currentTurn = null;
            setTimeout(() => startTurn(next).catch(() => {}), 1500);
          } else {
            currentTurn = null;
            clearTimeout(masterTimeout);
            try { ws.close(); } catch {}
            resolve({ callId, status: 'ok', tOpenMs: tOpen - t0, turns });
          }
        }
        return;
      }
      try { const m = JSON.parse(data.toString()); if (m.type === 'session_started' && !sessionStarted) { sessionStarted = true; startTurn(0).catch(() => {}); } } catch {}
    });
    ws.on('error', (err) => { clearTimeout(masterTimeout); resolve({ callId, status: 'error', error: err.message, tOpenMs: tOpen ? tOpen - t0 : null, turns }); });
    ws.on('close', () => { if (!sessionStarted) { clearTimeout(masterTimeout); resolve({ callId, status: 'closed_before_session', tOpenMs: tOpen ? tOpen - t0 : null, turns }); } });
  });
}

async function runEndpoint(name, url) {
  console.log(`\n>>> ${name} @ ${CONCURRENCY} concurrent  ${new Date().toISOString()}  ${url}`);
  const tStart = performance.now();
  const promises = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    promises.push(runOneCall(i, url));
    if (RAMP_MS > 0) await sleep(RAMP_MS);
  }
  const results = await Promise.all(promises);
  const elapsedMs = performance.now() - tStart;
  const ok = results.filter(r => r.status === 'ok');
  const failed = results.filter(r => r.status !== 'ok');
  const okTurns = results.flatMap(r => r.turns).filter(t => t.status === 'ok');
  const ttfa = okTurns.map(t => t.ttfaFromEoaMs);
  const connectList = results.filter(r => r.tOpenMs !== null).map(r => r.tOpenMs);
  const failureBreakdown = failed.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {});
  const summary = {
    name, url, concurrency: CONCURRENCY, elapsedMs: Math.round(elapsedMs),
    callsOk: ok.length, callsFailed: failed.length, pct: ((ok.length / CONCURRENCY) * 100).toFixed(1),
    turnsOk: okTurns.length,
    ttfa: ttfa.length ? { mean: Math.round(ttfa.reduce((s,v)=>s+v,0)/ttfa.length), p50: Math.round(quantile(ttfa, 0.5)), p95: Math.round(quantile(ttfa, 0.95)), p99: Math.round(quantile(ttfa, 0.99)), max: Math.round(Math.max(...ttfa)) } : null,
    connect: connectList.length ? { p50: Math.round(quantile(connectList, 0.5)), p95: Math.round(quantile(connectList, 0.95)) } : null,
    failureBreakdown,
  };
  console.log(`  calls ok/fail: ${summary.callsOk}/${summary.callsFailed} (${summary.pct}%)`);
  if (summary.ttfa) console.log(`  TTFA-from-EOA: mean=${summary.ttfa.mean}  p50=${summary.ttfa.p50}  p95=${summary.ttfa.p95}  p99=${summary.ttfa.p99}  max=${summary.ttfa.max} ms`);
  if (summary.connect) console.log(`  connect: p50=${summary.connect.p50}  p95=${summary.connect.p95} ms`);
  if (Object.keys(failureBreakdown).length) console.log(`  failures: ${JSON.stringify(failureBreakdown)}`);
  console.log(`  elapsed: ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  return summary;
}

async function main() {
  console.log(`Fair sequential 100-concurrent run, 5-min cooldown between transports`);
  console.log(`Start: ${new Date().toISOString()}`);
  const all = [];
  for (let i = 0; i < ENDPOINTS_ORDERED.length; i++) {
    const ep = ENDPOINTS_ORDERED[i];
    const r = await runEndpoint(ep.name, ep.url);
    all.push(r);
    if (i < ENDPOINTS_ORDERED.length - 1) {
      console.log(`\n--- cooldown ${COOLDOWN_MS / 1000}s before next transport ---`);
      await sleep(COOLDOWN_MS);
    }
  }
  console.log('\n=== Summary ===');
  console.log('endpoint  | calls-ok | TTFA p50 | TTFA p95 | TTFA p99 | TTFA max  | connect p50 | elapsed');
  for (const r of all) {
    console.log(
      `${r.name.padEnd(9)} | ${r.callsOk}/${r.concurrency} | ${r.ttfa?.p50 ?? '-'}ms | ${r.ttfa?.p95 ?? '-'}ms | ${r.ttfa?.p99 ?? '-'}ms | ${r.ttfa?.max ?? '-'}ms | ${r.connect?.p50 ?? '-'}ms | ${(r.elapsedMs/1000).toFixed(1)}s`,
    );
  }
}

main().catch(console.error);
