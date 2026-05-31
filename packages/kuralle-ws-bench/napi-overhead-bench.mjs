#!/usr/bin/env node
/**
 * Empirically measure the per-call NAPI marshaling cost on a "send a small
 * binary buffer" hot path — the exact thing voice WS frames hit at 50fps.
 *
 * Compare:
 *   - Pure JS object property access (control)
 *   - Crossing the NAPI boundary into wavekat-vad-node and back (representative
 *     of any napi-rs Buffer round-trip)
 *   - sockudo's WS send through its NAPI bridge (real workload simulation)
 *
 * We can't test sockudo's send without a connected client, so we measure the
 * Message.binary() factory call as a proxy — it's the cheapest sockudo NAPI
 * call and reveals the floor cost per crossing.
 */

import { performance } from 'node:perf_hooks';
import { Message } from '@sockudo/ws';

const ITER = 1_000_000;
const WARMUP = 100_000;

function bench(label, fn) {
  for (let i = 0; i < WARMUP; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < ITER; i++) fn();
  const elapsedMs = performance.now() - t0;
  const nsPerOp = (elapsedMs * 1e6) / ITER;
  console.log(`  ${label.padEnd(50)} ${nsPerOp.toFixed(1).padStart(8)} ns/op   (${(ITER * 1000 / elapsedMs / 1e6).toFixed(2)} Mops/sec)`);
}

const small = Buffer.alloc(320); // Twilio frame size
const medium = Buffer.alloc(960); // 24kHz 20ms frame
const large = Buffer.alloc(8192);

console.log(`Iter=${ITER.toLocaleString()}, warmup=${WARMUP.toLocaleString()}\n`);

console.log('Pure JS / V8 baseline:');
bench('property access (no NAPI)', () => { return small.length; });
bench('Buffer.alloc(320)', () => Buffer.alloc(320));
bench('Buffer.from(arr) length=320', () => Buffer.from(small));

console.log('\n@sockudo/ws Message factory (single NAPI cross):');
bench('Message.binary(320B Buffer)', () => Message.binary(small));
bench('Message.binary(960B Buffer)', () => Message.binary(medium));
bench('Message.binary(8KB Buffer)', () => Message.binary(large));
bench('Message.text("hello")', () => Message.text('hello'));

// The interesting comparison: sockudo's per-send cost is at minimum the
// Message factory + the .send() call (another NAPI cross). Doubling these
// numbers approximates the per-send floor cost.
