#!/usr/bin/env node
/**
 * Per-frame inference benchmark — does the WaveKat README claim
 * (WebRTC 2.7µs, TEN-VAD 62µs at frame size) hold up across the napi-rs
 * boundary?
 *
 * Run: node bench/inference.mjs
 */

import { Vad, WebRtcMode } from '../index.js';
import { performance } from 'node:perf_hooks';

function pcmFrame(numSamples, sampleRate, freq = 440, amplitude = 30000) {
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

function quantile(arr, q) {
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function benchOne(label, vad, frame, iterations) {
  // Warm up
  for (let i = 0; i < 1000; i++) vad.process(frame);

  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    vad.process(frame);
    const t1 = performance.now();
    samples.push((t1 - t0) * 1000); // µs
  }

  const sum = samples.reduce((s, v) => s + v, 0);
  const mean = sum / samples.length;
  const p50 = quantile(samples, 0.5);
  const p95 = quantile(samples, 0.95);
  const p99 = quantile(samples, 0.99);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  console.log(
    `${label.padEnd(28)}  iters=${iterations}  mean=${mean.toFixed(2)}µs  ` +
      `p50=${p50.toFixed(2)}µs  p95=${p95.toFixed(2)}µs  p99=${p99.toFixed(2)}µs  ` +
      `min=${min.toFixed(2)}µs  max=${max.toFixed(2)}µs`,
  );
}

const ITERATIONS = 50_000;

console.log('Per-frame VAD inference (across napi-rs boundary)');
console.log(`Iterations per case: ${ITERATIONS}, after 1000-iter warmup`);

// WebRTC at 16kHz, 30ms (480-sample frame)
{
  const vad = Vad.webrtc(16000, WebRtcMode.Quality, 30);
  const frame = pcmFrame(480, 16000);
  benchOne('WebRTC 16k/30ms', vad, frame, ITERATIONS);
}

// WebRTC at 16kHz, 10ms (160-sample frame)
{
  const vad = Vad.webrtc(16000, WebRtcMode.Quality, 10);
  const frame = pcmFrame(160, 16000);
  benchOne('WebRTC 16k/10ms', vad, frame, ITERATIONS);
}

// WebRTC at 8kHz, 20ms (160-sample frame) — Twilio-shaped
{
  const vad = Vad.webrtc(8000, WebRtcMode.Aggressive, 20);
  const frame = pcmFrame(160, 8000);
  benchOne('WebRTC 8k/20ms (Twilio)', vad, frame, ITERATIONS);
}

// TEN-VAD at 16kHz, 16ms (256-sample frame)
{
  const vad = Vad.tenVad();
  const frame = pcmFrame(256, 16000);
  benchOne('TEN-VAD 16k/16ms', vad, frame, ITERATIONS);
}

console.log('\nReference: WaveKat README v0.1.14');
console.log('  WebRTC: 2.7µs   TEN-VAD: 62µs   (Linux x86, --release)');
