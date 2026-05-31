#!/usr/bin/env node
/**
 * Smoke test: instantiate each backend, push known speech / silence buffers,
 * assert capabilities + that probabilities behave as expected.
 *
 * Speech fixture: a 16 kHz sine at ~440 Hz with full-scale amplitude — VAD
 * should classify as voiced for WebRTC and >0 for TEN-VAD. Silence: zeros.
 *
 * Run: bun run test  (or `node test/smoke.test.mjs`)
 */

import { Vad, WebRtcMode, VadBackend } from '../index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function sineBuffer(sampleRate, durationMs, freqHz, amplitude = 30000) {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

function silenceBuffer(sampleRate, durationMs) {
  return Buffer.alloc(Math.floor(sampleRate * durationMs * 2 / 1000));
}

test('WebRTC VAD: capabilities + speech detection', () => {
  const vad = Vad.webrtc(16000, WebRtcMode.Quality);
  assert.equal(vad.backend, VadBackend.Webrtc);
  assert.equal(vad.sampleRate, 16000);
  assert.equal(vad.frameDurationMs, 30); // default
  assert.equal(vad.frameSize, 480); // 30ms @ 16kHz

  // Push 100ms of sine — should fire at least 3 frames at 30ms each
  const speech = sineBuffer(16000, 100, 440);
  const speechProb = vad.process(speech);
  assert.notEqual(speechProb, null, 'a full frame should have been processed');
  assert.equal(speechProb, 1.0, `WebRTC should classify ~440Hz tone as voiced (got ${speechProb})`);
});

test('WebRTC VAD: silence is not voiced', () => {
  const vad = Vad.webrtc(16000, WebRtcMode.Aggressive);
  const silence = silenceBuffer(16000, 100);
  const prob = vad.process(silence);
  assert.notEqual(prob, null);
  assert.equal(prob, 0.0, `silence should be unvoiced (got ${prob})`);
});

test('WebRTC VAD: 8 kHz telephony rate accepted', () => {
  const vad = Vad.webrtc(8000, WebRtcMode.Quality, 20);
  assert.equal(vad.sampleRate, 8000);
  assert.equal(vad.frameDurationMs, 20);
  assert.equal(vad.frameSize, 160); // 20ms @ 8kHz
  const speech = sineBuffer(8000, 60, 300);
  const prob = vad.process(speech);
  assert.notEqual(prob, null);
});

test('FrameAdapter: small chunks accumulate, return null until a full frame arrives', () => {
  const vad = Vad.webrtc(16000, WebRtcMode.Quality, 30); // 480 samples per frame
  // 100 samples = 200 bytes. Below frame size → null.
  const tiny = sineBuffer(16000, 6.25, 440); // ~100 samples
  const result = vad.process(tiny);
  assert.equal(result, null, 'partial frame should yield null');
});

test('TEN-VAD: capabilities + speech detection', () => {
  const vad = Vad.tenVad();
  assert.equal(vad.backend, VadBackend.TenVad);
  assert.equal(vad.sampleRate, 16000);
  assert.equal(vad.frameDurationMs, 16);
  assert.equal(vad.frameSize, 256); // 16ms @ 16kHz

  // 100ms of sine = ~6 frames
  const speech = sineBuffer(16000, 100, 440);
  const prob = vad.process(speech);
  assert.notEqual(prob, null);
  assert.ok(prob >= 0 && prob <= 1, `prob in [0,1] (got ${prob})`);
});

test('TEN-VAD: silence yields low probability', () => {
  const vad = Vad.tenVad();
  const silence = silenceBuffer(16000, 100);
  const prob = vad.process(silence);
  assert.notEqual(prob, null);
  assert.ok(prob < 0.5, `silence should yield low prob (got ${prob})`);
});

test('TEN-VAD: speech yields higher prob than silence', () => {
  const vadSpeech = Vad.tenVad();
  const vadSilence = Vad.tenVad();
  // Use repeated speech-like pattern (mix of sines) for more realistic input
  const speechBuf = Buffer.concat([
    sineBuffer(16000, 100, 220),
    sineBuffer(16000, 100, 440),
    sineBuffer(16000, 100, 880),
  ]);
  const silence = silenceBuffer(16000, 300);

  // Push to drain
  let lastSpeech = vadSpeech.process(speechBuf);
  let lastSilence = vadSilence.process(silence);
  for (let i = 0; i < 5; i++) {
    lastSpeech = vadSpeech.process(speechBuf) ?? lastSpeech;
    lastSilence = vadSilence.process(silence) ?? lastSilence;
  }

  assert.ok(
    lastSpeech > lastSilence,
    `speech prob (${lastSpeech}) should exceed silence prob (${lastSilence})`,
  );
});

test('odd-byte buffers are rejected', () => {
  const vad = Vad.webrtc(16000, WebRtcMode.Quality);
  const odd = Buffer.alloc(101); // not multiple of 2
  assert.throws(() => vad.process(odd), /multiple of 2/);
});
