# @kuralle-agents/wavekat-vad-node

Node.js bindings for [`wavekat-vad`](https://crates.io/crates/wavekat-vad) — Rust-native voice activity detection. Built with napi-rs.

Backends shipped: **WebRTC VAD** (binary, ultra-low latency, supports 8/16/32/48 kHz) and **TEN-VAD** (continuous probability, 16 kHz, ONNX-free pure-Rust port from Agora).

## Why

For voice agent workloads (Twilio Media Streams, browser mic streams), VAD runs per audio frame at 50 fps. JavaScript VAD libraries (`@ricky0123/vad-node`, etc.) typically hit ~1–5 ms per frame because they execute ONNX in JS. A Rust-native VAD called through napi-rs gets the inference into microseconds while keeping the same callsite ergonomics.

## Install

This package is workspace-internal. Build the native binary first:

```bash
cd packages/kuralle-wavekat-vad-node
npx napi build --platform --release
```

That produces `kuralle-wavekat-vad-node.<platform>.node` next to `index.js`. The hand-written `index.js` loader picks the right binary by `process.platform-process.arch`.

Targets configured: `darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`. To build for another target, pass `--target <triple>`.

## Usage

```js
import { Vad, WebRtcMode } from '@kuralle-agents/wavekat-vad-node';

// WebRTC: binary 0/1 output. Sample rates 8/16/32/48 kHz.
const vad = Vad.webrtc(16000, WebRtcMode.Quality);            // 30ms frames (default)
const vadFast = Vad.webrtc(16000, WebRtcMode.Aggressive, 10); // 10ms frames
const vadTwilio = Vad.webrtc(8000, WebRtcMode.Aggressive, 20); // 8 kHz μ-law-resampled telephony

// TEN-VAD: continuous probability 0..1, 16 kHz fixed, 16ms frames.
const ten = Vad.tenVad();

// Push PCM 16-bit LE buffers as they arrive (any chunk size — frame
// adapter buffers internally).
const probability = vad.process(pcmBuffer);
// → null while the buffer hasn't completed a frame yet
// → 0 or 1   for WebRTC
// → 0..1     for TEN-VAD (`> 0.5` ≈ speech by convention)

console.log(vad.frameSize, vad.frameDurationMs, vad.sampleRate, vad.backend);
```

### Twilio Media Streams shape

Twilio sends μ-law @ 8 kHz, ~20ms frames (160 samples / 320 bytes). After μ-law → PCM16 conversion you can feed those frames directly to `Vad.webrtc(8000, ..., 20)`.

For TEN-VAD or anything 16 kHz, upsample first (e.g., with `wavekat`'s preprocessing layer at the Rust side, or any JS resampler upstream of `process()`).

## API

### `Vad.webrtc(sampleRate, mode, frameDurationMs?)`

`sampleRate`: `8000 | 16000 | 32000 | 48000`.
`mode`: `WebRtcMode.Quality | LowBitrate | Aggressive | VeryAggressive`.
`frameDurationMs`: `10 | 20 | 30` (default `30`).

### `Vad.tenVad()`

No arguments. 16 kHz, 16ms frames are baked in.

### `vad.process(pcm: Buffer): number | null`

Push i16 LE samples. Returns the most-recently-completed frame's probability, or `null` if not enough samples have arrived to fill one frame.

For WebRTC, return values are exactly `0` or `1`. For TEN-VAD, `0..1`.

### Read-only properties

- `frameSize` — required samples per frame.
- `frameDurationMs` — frame duration in ms.
- `sampleRate` — current rate.
- `backend` — `'Webrtc' | 'TenVad'`.

## Tests

```bash
node --test test/smoke.test.mjs
```

Covers capabilities, speech-vs-silence behavior at 16 kHz and 8 kHz, FrameAdapter buffering, and rejection of odd-byte buffers. 8 tests total, all backends exercised.

## Performance

Measured on Apple M-series, `--release`, 50 000 iterations after 1 000-iter warmup, going through the napi-rs binding:

| Backend | Config | mean | p50 | p95 | p99 |
|---|---|---|---|---|---|
| WebRTC | 16k / 30ms | 5.1µs | 3.0µs | 6.8µs | 15.9µs |
| WebRTC | 16k / 10ms | 4.9µs | 1.2µs | 3.3µs | 5.3µs |
| WebRTC | 8k / 20ms | 3.4µs | 1.5µs | 3.9µs | 6.6µs |
| TEN-VAD | 16k / 16ms | 42.9µs | 36.8µs | 55.0µs | 168.9µs |

Reference: WaveKat README v0.1.14 quotes WebRTC 2.7µs and TEN-VAD 62µs on Linux x86. WebRTC matches; **TEN-VAD is ~40% faster on Apple Silicon** thanks to NEON SIMD.

For voice agent budgets (50 fps = 20 ms / frame), TEN-VAD p99 of 169µs leaves >99% headroom — essentially free.

Run yourself:

```bash
node bench/inference.mjs
```

## Notes & gotchas

- **napi-rs v3 + cfg-gated factory methods**: gating two `#[napi(factory)]` impls behind `cfg(feature = "ten-vad")` produced "cannot find value `__napi__ten_vad`" — the macro registers the symbol unconditionally. We resolved by always compiling both backends. If you bring back conditional compilation, expose them as separate `Vad` types or guard the entire `impl` block, not individual methods.

- **Auto type-def generation didn't fire** on this v3 CLI build profile. `index.js` and `index.d.ts` are hand-written to match `src/lib.rs`. Keep them in sync if you change the Rust API.

- **`FrameAdapter` is single-threaded**. For parallel calls share a Worker per session, not a single Vad across threads. (napi-rs holds the binding to one thread by default.)

## License

MIT.
