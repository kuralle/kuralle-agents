/**
 * Audio resampling backed by @livekit/rtc-node AudioResampler.
 *
 * Uses Sox sinc interpolation via a local Rust FFI call (no LiveKit server needed).
 * Replaces the previous naive linear-interpolation upsample() and box-average
 * downsample() which lacked anti-alias filtering and produced artifacts.
 */
import { AudioFrame, AudioResampler, AudioResamplerQuality } from '@livekit/rtc-node';

/**
 * Create a streaming resampler for real-time audio pipelines.
 *
 * Usage:
 *   const resampler = createResampler(8000, 16000);
 *   const outFrames = resampler.push(inputFrame);  // may return 0+ frames
 *   const remaining = resampler.flush();            // drain at end
 */
export function createResampler(
  inputRate: number,
  outputRate: number,
  channels = 1,
  quality = AudioResamplerQuality.MEDIUM,
): AudioResampler {
  return new AudioResampler(inputRate, outputRate, channels, quality);
}

/**
 * One-shot resample for transport code that works with raw Int16Array.
 *
 * Handles both upsampling and downsampling in a single function.
 * For streaming pipelines, prefer createResampler() to avoid
 * creating a new resampler instance per call.
 */
export function resample(
  input: Int16Array,
  fromRate: number,
  toRate: number,
  channels = 1,
): Int16Array {
  if (fromRate === toRate) return new Int16Array(input);
  if (input.length === 0) return new Int16Array(0);

  const resampler = new AudioResampler(fromRate, toRate, channels);
  const frame = new AudioFrame(input, fromRate, channels, input.length / channels);
  const out = resampler.push(frame);
  const flushed = resampler.flush();
  const all = [...out, ...flushed];

  if (all.length === 0) return new Int16Array(0);

  const totalSamples = all.reduce((sum, f) => sum + f.data.length, 0);
  const result = new Int16Array(totalSamples);
  let offset = 0;
  for (const f of all) {
    result.set(f.data, offset);
    offset += f.data.length;
  }
  return result;
}
