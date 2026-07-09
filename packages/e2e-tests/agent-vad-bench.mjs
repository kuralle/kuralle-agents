#!/usr/bin/env node
/**
 * Compare two endpointing strategies, end-to-end through the Kuralle voice
 * agent on Fly:
 *
 *   A. Client-driven endpointing (existing sockudo agent):
 *      send PCM → 250 ms silence → JSON `{type:"end_of_audio"}` → wait for
 *      audio reply. TTFA measured from "client sent EOA JSON".
 *
 *   B. Server-side wavekat TEN-VAD endpointing (sockudo+VAD agent):
 *      send PCM → 800 ms silence (enough for VAD's 300 ms holdoff with
 *      margin) → wait for audio reply. NO EOA JSON sent. TTFA measured
 *      from "client sent last audio chunk".
 *
 * The metric is "time from when the user stopped talking (or the audio
 * stream ended) to when the bot starts replying". Both modes are timed in
 * the same way for a fair comparison: from the moment the bench's last
 * paced-frame send completes.
 *
 * Run:
 *   TURNS=4 node agent-vad-bench.mjs
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
];
const PCMS = TURN_FIXTURES.map((t) => ({
  ...t, pcm: readFileSync(join(__dirname, 'fixtures', t.file)),
}));

const ENDPOINTS = [
  {
    name: 'sockudo (client EOA)',
    url: 'wss://kuralle-voice-agent-sockudo.fly.dev',
    mode: 'client_eoa',
    silenceMs: 250,
  },
  {
    name: 'sockudo+VAD (server VAD)',
    url: 'wss://kuralle-voice-agent-sockudo-vad.fly.dev',
    mode: 'server_vad',
    silenceMs: 800, // give VAD time to detect 300ms holdoff with margin
  },
];

const TURNS = Number(process.env.TURNS ?? 4);
const FRAME_MS = 20;
const FRAME_BYTES = 960;
const TURN_TIMEOUT_MS = 30000;
const INTER_TURN_GAP_MS = 4000;

function silenceBuf(ms, sampleRate = 24000) {
  return Buffer.alloc(Math.floor((sampleRate * ms) / 1000) * 2);
}

async function sendPaced(ws, pcm) {
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(pcm.slice(off, Math.min(off + FRAME_BYTES, pcm.length)), { binary: true });
    const j = (Math.random() * 2 - 1) * 4;
    await new Promise((r) => setTimeout(r, Math.max(1, FRAME_MS + j)));
  }
}

function avg(arr) { return arr.length ? Math.round(arr.reduce((s,v)=>s+v,0) / arr.length) : 0; }

async function runEndpoint({ name, url, mode, silenceMs }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ws = new WebSocket(url);
    let tOpen = 0;
    const turns = [];
    let currentTurn = null;

    const fail = (err) => {
      try { ws.terminate(); } catch {}
      reject(new Error(typeof err === 'string' ? err : err.message));
    };
    const masterTimeout = setTimeout(() => fail('master timeout'), TURNS * TURN_TIMEOUT_MS + 60000);

    async function startTurn(idx) {
      const fx = PCMS[idx % PCMS.length];
      currentTurn = {
        idx, label: fx.label,
        tLastChunkSent: 0, tFirstAudio: 0,
      };
      const tt = setTimeout(() => fail(`turn ${idx} timeout`), TURN_TIMEOUT_MS);
      currentTurn._timeout = tt;

      // Reset VAD state on the server for the new turn (server-VAD mode).
      if (mode === 'server_vad') {
        try { ws.send(JSON.stringify({ type: 'reset_turn' })); } catch {}
      }

      // Send the utterance, then the silence pad. Mark "last chunk sent"
      // as the moment AFTER the silence pad finishes (= "user stopped
      // talking from the server's perspective").
      await sendPaced(ws, fx.pcm);
      await sendPaced(ws, silenceBuf(silenceMs));
      if (!currentTurn || ws.readyState !== ws.OPEN) return;
      currentTurn.tLastChunkSent = performance.now();
      // In client-EOA mode, send the JSON now. In server-VAD mode, do
      // nothing — VAD on the server should detect end of speech.
      if (mode === 'client_eoa') {
        try { ws.send(JSON.stringify({ type: 'end_of_audio' })); } catch {}
      }
    }

    ws.on('open', () => { tOpen = Date.now(); });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (currentTurn && currentTurn.tLastChunkSent && !currentTurn.tFirstAudio) {
          currentTurn.tFirstAudio = performance.now();
          clearTimeout(currentTurn._timeout);
          turns.push({
            idx: currentTurn.idx,
            label: currentTurn.label,
            ttfaFromLastChunkMs: Math.round(currentTurn.tFirstAudio - currentTurn.tLastChunkSent),
          });
          if (currentTurn.idx < TURNS - 1) {
            const next = currentTurn.idx + 1;
            currentTurn = null;
            setTimeout(() => startTurn(next).catch((e) => fail(e)), INTER_TURN_GAP_MS);
          } else {
            currentTurn = null;
            clearTimeout(masterTimeout);
            try { ws.close(); } catch {}
            resolve({ name, url, mode, connectMs: tOpen - t0, turns });
          }
        }
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session_started') startTurn(0).catch((e) => fail(e));
        // also log VAD endpointing events for transparency
        if (msg.type === 'vad_endpointed' && currentTurn) {
          // The server VAD fired — log timing for debugging
          // (TTFA-from-last-chunk is still measured against tLastChunkSent)
        }
      } catch { /* ignore */ }
    });

    ws.on('error', (err) => { clearTimeout(masterTimeout); reject(err); });
  });
}

async function main() {
  console.log(`VAD endpointing comparison  TURNS=${TURNS}`);
  console.log(`Metric: TTFA from last audio chunk sent (= "user stopped talking")\n`);
  const results = {};
  for (const ep of ENDPOINTS) {
    console.log(`=== ${ep.name} (mode=${ep.mode}, silencePad=${ep.silenceMs}ms) ===`);
    console.log(`    ${ep.url}`);
    try {
      const r = await runEndpoint(ep);
      results[ep.name] = r;
      console.log(`  connect: ${r.connectMs}ms`);
      r.turns.forEach((t) => {
        console.log(`  turn ${t.idx} ${t.label}: TTFA-from-last-chunk=${t.ttfaFromLastChunkMs}ms`);
      });
    } catch (err) {
      console.log(`  FAIL: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }

  console.log('\n=== Summary ===');
  for (const ep of ENDPOINTS) {
    const r = results[ep.name];
    if (!r) { console.log(`${ep.name}: failed`); continue; }
    const cold = r.turns[0]?.ttfaFromLastChunkMs ?? 0;
    const warm = r.turns.slice(1);
    const warmAvg = avg(warm.map((t) => t.ttfaFromLastChunkMs));
    console.log(`${ep.name.padEnd(28)}  connect=${r.connectMs}ms  cold=${cold}ms  warm-avg=${warmAvg}ms (n=${warm.length})`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
