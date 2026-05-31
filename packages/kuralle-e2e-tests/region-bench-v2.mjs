#!/usr/bin/env node
/**
 * Region benchmark v2 — closer to real browser experience.
 *  - Single WS per region, 4 turns per session (warm connection after turn 1).
 *  - 250ms silence padding (matches Deepgram endpointing) instead of 1200ms.
 *  - Reports TTFA both from speech-end (perceived latency) and from open.
 */

import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

const URL = 'wss://kuralle-voice-agent.fly.dev';
const PCM = readFileSync('/Users/mithushancj/Documents/asyncdot/openscoped/aria-flow/packages/kuralle-e2e-tests/fixtures/bench_hello.pcm');
const REGIONS = ['iad', 'sin'];
const TURNS_PER_REGION = 4;
const SILENCE_MS = 250;
const TURN_TIMEOUT_MS = 30000;
const INTER_TURN_GAP_MS = 4000;

function generateSilence(durationMs, sampleRate = 24000) {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  return Buffer.alloc(numSamples * 2);
}

async function sendPacedFrames(ws, pcm, frameBytes = 960, frameMs = 20) {
  for (let off = 0; off < pcm.length; off += frameBytes) {
    const end = Math.min(off + frameBytes, pcm.length);
    ws.send(pcm.slice(off, end));
    await new Promise(r => setTimeout(r, frameMs));
  }
}

async function runRegion(region) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ws = new WebSocket(URL, { headers: { 'fly-prefer-region': region } });
    let tOpen = 0;
    const turns = [];
    let currentTurn = null;
    let sessionStarted = false;

    const fail = (msg) => { try { ws.terminate(); } catch {} reject(new Error(msg)); };
    const masterTimeout = setTimeout(() => fail('master timeout'), TURNS_PER_REGION * TURN_TIMEOUT_MS + 30000);

    async function runTurn(idx) {
      currentTurn = {
        idx,
        tStart: Date.now(),
        tEndOfAudio: 0,
        tFirstAudio: 0,
      };
      const turnTimeout = setTimeout(() => fail(`turn ${idx} timeout`), TURN_TIMEOUT_MS);
      currentTurn._timeout = turnTimeout;
      // Stream audio + 250ms silence, then end_of_audio
      await sendPacedFrames(ws, PCM, 960, 20);
      await sendPacedFrames(ws, generateSilence(SILENCE_MS), 960, 20);
      if (!currentTurn) return;
      currentTurn.tEndOfAudio = Date.now();
      try { ws.send(JSON.stringify({ type: 'end_of_audio' })); } catch {}
    }

    ws.on('open', () => { tOpen = Date.now(); });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        // Only count as TTFA if (a) we have an active turn, (b) we've already
        // sent end_of_audio for it, (c) we haven't already captured first audio.
        // This filters trailing audio from the previous bot turn.
        if (currentTurn && currentTurn.tEndOfAudio && !currentTurn.tFirstAudio) {
          currentTurn.tFirstAudio = Date.now();
          clearTimeout(currentTurn._timeout);
          turns.push({
            idx: currentTurn.idx,
            ttfaFromOpenMs: currentTurn.tFirstAudio - tOpen,
            ttfaFromEoaMs: currentTurn.tFirstAudio - currentTurn.tEndOfAudio,
            ttfaFromTurnStartMs: currentTurn.tFirstAudio - currentTurn.tStart,
          });
          // Wait for the bot's audio to flush (drain a bit), then start next turn
          if (currentTurn.idx < TURNS_PER_REGION - 1) {
            const nextIdx = currentTurn.idx + 1;
            currentTurn = null;
            // Drain remaining bot audio briefly (consume but ignore)
            setTimeout(() => runTurn(nextIdx), INTER_TURN_GAP_MS);
          } else {
            currentTurn = null;
            clearTimeout(masterTimeout);
            try { ws.close(); } catch {}
            resolve({ region, connectMs: tOpen - t0, turns });
          }
        }
        // After tFirstAudio set, keep draining binary frames silently
      } else {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'session_started' && !sessionStarted) {
            sessionStarted = true;
            runTurn(0);
          }
        } catch {}
      }
    });

    ws.on('error', err => { clearTimeout(masterTimeout); reject(err); });
    ws.on('close', () => { /* resolved or rejected elsewhere */ });
  });
}

function avg(arr) { return arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0; }

async function main() {
  const all = {};
  for (const region of REGIONS) {
    console.log(`\n=== Region: ${region} (single WS, ${TURNS_PER_REGION} turns, ${SILENCE_MS}ms endpointing) ===`);
    try {
      const r = await runRegion(region);
      all[region] = r;
      console.log(`  connect: ${r.connectMs}ms`);
      r.turns.forEach(t => {
        console.log(`  turn ${t.idx}: TTFA-from-EOA=${t.ttfaFromEoaMs}ms  TTFA-from-open=${t.ttfaFromOpenMs}ms`);
      });
    } catch (e) {
      console.log(`  FAIL: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n=== Summary (warm = avg of turns 2..N, cold = turn 1) ===');
  for (const region of REGIONS) {
    const r = all[region];
    if (!r) { console.log(`${region}: failed`); continue; }
    const cold = r.turns[0];
    const warm = r.turns.slice(1);
    console.log(`${region}: connect=${r.connectMs}ms  cold-TTFA-from-EOA=${cold.ttfaFromEoaMs}ms  warm-TTFA-from-EOA=${avg(warm.map(t=>t.ttfaFromEoaMs))}ms  (n_warm=${warm.length})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
