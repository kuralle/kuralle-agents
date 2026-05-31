#!/usr/bin/env node
/**
 * Quick region benchmark: SL client → Fly machine in <region> → Deepgram + Gemini → audio back.
 * Measures TTFA (time-to-first-audio) per region by setting Fly-Prefer-Region header.
 */

import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

const URL = 'wss://kuralle-voice-agent.fly.dev';
const PCM = readFileSync('/Users/mithushancj/Documents/asyncdot/openscoped/aria-flow/packages/kuralle-e2e-tests/fixtures/bench_hello.pcm');
const REGIONS = ['iad', 'sin'];
const RUNS_PER_REGION = 3;

function generateSilence(durationMs, sampleRate = 24000) {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  return Buffer.alloc(numSamples * 2);
}

async function sendPacedFrames(ws, pcm, frameBytes = 960, frameMs = 20) {
  const total = pcm.length;
  for (let off = 0; off < total; off += frameBytes) {
    const end = Math.min(off + frameBytes, total);
    ws.send(pcm.slice(off, end));
    await new Promise(r => setTimeout(r, frameMs));
  }
}

async function runOnce(region) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ws = new WebSocket(URL, { headers: { 'fly-prefer-region': region } });
    let tOpen = 0, tSessionStarted = 0, tFirstAudio = 0;
    let machineRegion = '';
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('timeout')); }, 60000);

    ws.on('open', () => { tOpen = Date.now(); });
    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        if (!tFirstAudio) {
          tFirstAudio = Date.now();
          clearTimeout(timeout);
          ws.close();
          resolve({
            region,
            actualRegion: machineRegion,
            connectMs: tOpen - t0,
            ttfaFromOpenMs: tFirstAudio - tOpen,
            ttfaFromSessionMs: tSessionStarted ? tFirstAudio - tSessionStarted : null,
            totalMs: tFirstAudio - t0,
          });
        }
      } else {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session_started') {
            tSessionStarted = Date.now();
            machineRegion = msg.region || msg.fly_region || '';
            // Send audio after session start
            (async () => {
              await sendPacedFrames(ws, PCM, 960, 20);
              await sendPacedFrames(ws, generateSilence(1200), 960, 20);
              try { ws.send(JSON.stringify({ type: 'end_of_audio' })); } catch {}
            })();
          }
        } catch {}
      }
    });
    ws.on('error', err => { clearTimeout(timeout); reject(err); });
  });
}

async function main() {
  const results = {};
  for (const region of REGIONS) {
    results[region] = [];
    console.log(`\n=== Region: ${region} ===`);
    for (let i = 0; i < RUNS_PER_REGION; i++) {
      try {
        const r = await runOnce(region);
        results[region].push(r);
        console.log(`  run ${i+1}: connect=${r.connectMs}ms  TTFA(from-open)=${r.ttfaFromOpenMs}ms  total=${r.totalMs}ms`);
      } catch (e) {
        console.log(`  run ${i+1}: FAIL ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log('\n=== Summary ===');
  for (const region of REGIONS) {
    const rs = results[region];
    if (!rs.length) { console.log(`${region}: no successful runs`); continue; }
    const avgConnect = Math.round(rs.reduce((s, r) => s + r.connectMs, 0) / rs.length);
    const avgTTFA = Math.round(rs.reduce((s, r) => s + r.ttfaFromOpenMs, 0) / rs.length);
    const avgTotal = Math.round(rs.reduce((s, r) => s + r.totalMs, 0) / rs.length);
    console.log(`${region}: avg connect=${avgConnect}ms  TTFA-from-open=${avgTTFA}ms  total=${avgTotal}ms  (n=${rs.length})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
