#!/usr/bin/env node
/**
 * Measures the two cascaded-pipeline compute stages we can drive directly with
 * real APIs (Deepgram), to turn the V2V budget estimate into measured numbers:
 *   - STT finalization: stream a real PCM speech sample, CloseStream, time to
 *     the final transcript (pure recognition tail; endpointing budgeted apart).
 *   - TTS time-to-first-byte: Aura speak, time to first audio byte.
 * The LLM term (runtime TTFT) is measured separately on the deployed worker.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const env = readFileSync(join(ROOT, '.env'), 'utf8');
const KEY = (env.match(/^DEEPGRAM_API_KEY=(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
if (!KEY) { console.error('DEEPGRAM_API_KEY not found in .env'); process.exit(1); }

const SAMPLE_RATE = 24000;
const PCM = readFileSync(join(__dir, 'fixtures', 'turn1_book_appointment.pcm'));
const REPS = Number(process.env.REPS || 5);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// --- STT: stream PCM fast, CloseStream, measure to final transcript ----------
function sttFinalize() {
  return new Promise((resolve, reject) => {
    const url = `wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=${SAMPLE_RATE}&channels=1&interim_results=true&punctuate=true`;
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${KEY}` } });
    let tFirstPartial = null;
    let tClose = null;
    let transcript = '';
    const t0 = performance.now();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    ws.on('open', async () => {
      // Stream in 40ms frames at REAL-TIME pace so Deepgram recognizes
      // continuously (as a live mic would) — the audio-end→final tail then
      // reflects the true streaming finalization cost, not whole-buffer processing.
      const frameMs = 40;
      const frame = SAMPLE_RATE * 2 * (frameMs / 1000);
      for (let i = 0; i < PCM.length; i += frame) {
        ws.send(PCM.subarray(i, i + frame));
        await sleep(frameMs);
      }
      tClose = performance.now();
      ws.send(JSON.stringify({ type: 'CloseStream' }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const alt = msg.channel?.alternatives?.[0];
      if (alt?.transcript && tFirstPartial === null) tFirstPartial = performance.now() - t0;
      if (msg.is_final && alt?.transcript) transcript = alt.transcript;
      if (msg.type === 'Metadata' || msg.from_finalize) {
        ws.close();
        resolve({ firstPartialMs: tFirstPartial, finalizeMs: performance.now() - tClose, transcript });
      }
    });
    ws.on('error', reject);
    setTimeout(() => { try { ws.close(); } catch {} resolve({ firstPartialMs: tFirstPartial, finalizeMs: performance.now() - (tClose ?? t0), transcript }); }, 8000);
  });
}

// --- TTS: Aura speak, measure time-to-first-audio-byte -----------------------
async function ttsTtfb(text) {
  const t0 = performance.now();
  const res = await fetch(
    `https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=${SAMPLE_RATE}`,
    { method: 'POST', headers: { Authorization: `Token ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) },
  );
  if (!res.ok || !res.body) throw new Error(`TTS ${res.status}: ${await res.text().catch(() => '')}`);
  const reader = res.body.getReader();
  let ttfb = null;
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (ttfb === null) ttfb = performance.now() - t0;
    bytes += value.length;
  }
  return { ttfbMs: ttfb, bytes };
}

async function main() {
  console.log(`Deepgram cascaded stages | reps: ${REPS} | STT nova-2, TTS aura-2 | 24kHz linear16\n`);
  console.log(`STT input: turn1_book_appointment.pcm (${(PCM.length / (SAMPLE_RATE * 2)).toFixed(2)}s of speech)\n`);

  const sttFirst = [], sttFinal = []; let lastTranscript = '';
  for (let i = 0; i < REPS; i += 1) {
    const r = await sttFinalize();
    if (r.firstPartialMs != null) sttFirst.push(r.firstPartialMs);
    sttFinal.push(r.finalizeMs);
    lastTranscript = r.transcript || lastTranscript;
  }
  const tts = [];
  for (let i = 0; i < REPS; i += 1) tts.push((await ttsTtfb('Our clinic is open Monday to Friday, eight AM to six PM.')).ttfbMs);

  console.log(`STT transcript            : "${lastTranscript}"`);
  console.log(`STT time-to-first-partial : ${Math.round(median(sttFirst))} ms (median)`);
  console.log(`STT finalize (audio-end→final): ${Math.round(median(sttFinal))} ms (median)`);
  console.log(`TTS time-to-first-byte    : ${Math.round(median(tts))} ms (median, Aura-2)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
