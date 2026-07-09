#!/usr/bin/env node
/**
 * Multi-turn Kuralle voice agent benchmark across two transports.
 *
 * Connects to each endpoint over WS, opens a single voice session, then runs
 * N turns of (send `bench_hello.pcm` + 250 ms silence + `end_of_audio` JSON,
 * wait for first audio frame back). Reports per-turn TTFA-from-EOA + summary.
 *
 * Run:
 *   node agent-multiturn-bench.mjs
 */

import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Multiple distinct user utterances drive a more honest multi-turn test —
// Deepgram sees varied input each turn, Gemini has to actually answer
// instead of pattern-matching the same prompt, the agent's flow state can
// progress. All fixtures are PCM s16le @ 24kHz mono, the format the voice
// agent's WebSocketTransportAdapter expects (and what a browser's
// `getUserMedia → AudioWorklet` would produce after resampling).
const TURN_FIXTURES = [
  { label: '"hello"', file: 'bench_hello.pcm' },
  { label: '"weather"', file: 'bench_weather.pcm' },
  { label: '"party of four"', file: 'flow_restaurant_party_of_four.pcm' },
  { label: '"six pm please"', file: 'flow_restaurant_six_pm.pcm' },
  { label: '"goodbye"', file: 'bench_goodbye.pcm' },
];
const PCMS = TURN_FIXTURES.map((t) => ({
  ...t,
  pcm: readFileSync(join(__dirname, 'fixtures', t.file)),
}));

const ENDPOINTS = [
  { name: 'ws@8 (existing Fly)', url: 'wss://kuralle-voice-agent.fly.dev' },
  { name: 'sockudo (new Fly)', url: 'wss://kuralle-voice-agent-sockudo.fly.dev' },
];

const TURNS = Number(process.env.TURNS ?? 4);
const SILENCE_MS = Number(process.env.SILENCE_MS ?? 250);
const INTER_TURN_GAP_MS = Number(process.env.INTER_TURN_GAP_MS ?? 4000);
const TURN_TIMEOUT_MS = 30000;
const JITTER_MS = Number(process.env.JITTER_MS ?? 4); // ±N ms jitter on frame pacing
const SEED_VARY = process.env.VARY === '1' || process.env.VARY === undefined; // default on

function generateSilence(durationMs, sampleRate = 24000) {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  return Buffer.alloc(numSamples * 2);
}

async function sendPaced(ws, pcm, frameBytes = 960, frameMs = 20) {
  for (let off = 0; off < pcm.length; off += frameBytes) {
    const end = Math.min(off + frameBytes, pcm.length);
    ws.send(pcm.slice(off, end), { binary: true });
    // Small uniform jitter to mimic real browser pacing — browsers can't hit
    // exact 20ms intervals because the JS event loop is opportunistic.
    const jitter = JITTER_MS > 0 ? (Math.random() * 2 - 1) * JITTER_MS : 0;
    await new Promise((r) => setTimeout(r, Math.max(1, frameMs + jitter)));
  }
}

function fixtureForTurn(idx) {
  if (!SEED_VARY) return PCMS[0];
  return PCMS[idx % PCMS.length];
}

function avg(arr) {
  return arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
}

async function runEndpoint({ name, url }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ws = new WebSocket(url);
    let tOpen = 0;
    const turns = [];
    let currentTurn = null;

    const fail = (msg) => {
      try { ws.terminate(); } catch {}
      reject(new Error(msg));
    };

    const masterTimeout = setTimeout(() => fail('master timeout'), TURNS * TURN_TIMEOUT_MS + 60000);

    async function startTurn(idx) {
      const fixture = fixtureForTurn(idx);
      currentTurn = {
        idx,
        utterance: fixture.label,
        tStart: Date.now(),
        tEndOfAudio: 0,
        tFirstAudio: 0,
      };
      const turnTimeout = setTimeout(() => fail(`turn ${idx} timeout`), TURN_TIMEOUT_MS);
      currentTurn._timeout = turnTimeout;

      await sendPaced(ws, fixture.pcm, 960, 20);
      await sendPaced(ws, generateSilence(SILENCE_MS), 960, 20);
      if (!currentTurn) return;
      currentTurn.tEndOfAudio = Date.now();
      try { ws.send(JSON.stringify({ type: 'end_of_audio' })); } catch {}
    }

    ws.on('open', () => {
      tOpen = Date.now();
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (currentTurn && currentTurn.tEndOfAudio && !currentTurn.tFirstAudio) {
          currentTurn.tFirstAudio = Date.now();
          clearTimeout(currentTurn._timeout);
          turns.push({
            idx: currentTurn.idx,
            utterance: currentTurn.utterance,
            ttfaFromOpenMs: currentTurn.tFirstAudio - tOpen,
            ttfaFromEoaMs: currentTurn.tFirstAudio - currentTurn.tEndOfAudio,
          });
          if (currentTurn.idx < TURNS - 1) {
            const nextIdx = currentTurn.idx + 1;
            currentTurn = null;
            setTimeout(() => startTurn(nextIdx), INTER_TURN_GAP_MS);
          } else {
            currentTurn = null;
            clearTimeout(masterTimeout);
            try { ws.close(); } catch {}
            resolve({ name, url, connectMs: tOpen - t0, turns });
          }
        }
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session_started') {
          startTurn(0);
        }
      } catch {
        // ignore non-JSON
      }
    });

    ws.on('error', (err) => {
      clearTimeout(masterTimeout);
      reject(err);
    });
  });
}

async function main() {
  console.log(`Multi-turn agent bench  TURNS=${TURNS}  SILENCE_MS=${SILENCE_MS}  GAP=${INTER_TURN_GAP_MS}ms`);
  const results = {};
  for (const ep of ENDPOINTS) {
    console.log(`\n=== ${ep.name} ===  ${ep.url}`);
    try {
      const r = await runEndpoint(ep);
      results[ep.name] = r;
      console.log(`  connect: ${r.connectMs}ms`);
      r.turns.forEach((t) => {
        console.log(`  turn ${t.idx} ${t.utterance}: TTFA-from-EOA=${t.ttfaFromEoaMs}ms`);
      });
    } catch (err) {
      console.log(`  FAIL: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }

  console.log('\n=== Summary ===');
  for (const ep of ENDPOINTS) {
    const r = results[ep.name];
    if (!r) {
      console.log(`${ep.name}: failed`);
      continue;
    }
    const cold = r.turns[0];
    const warm = r.turns.slice(1);
    const warmAvg = avg(warm.map((t) => t.ttfaFromEoaMs));
    console.log(`${ep.name}:  connect=${r.connectMs}ms  cold-TTFA=${cold?.ttfaFromEoaMs ?? '-'}ms  warm-avg-TTFA=${warmAvg}ms (n=${warm.length})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
