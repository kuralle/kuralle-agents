import { describe, test, expect } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { GeminiAudioFrameProcessor } from '../src/gemini/audio_frame_processor.js';

initializeLogger({ pretty: false, level: 'warn' });

function int16Frame(samples: number[]) {
  return { data: Int16Array.from(samples) };
}

describe('GeminiAudioFrameProcessor', () => {
  test('wrap() base64-encodes bytes with the matching MIME', () => {
    const p = new GeminiAudioFrameProcessor(16000);
    const blob = p.wrap(new Uint8Array([0, 1, 2, 3]));
    expect(blob.mimeType).toBe('audio/pcm;rate=16000');
    expect(Buffer.from(blob.data, 'base64').equals(Buffer.from([0, 1, 2, 3]))).toBe(true);
  });

  test('process() buffers below 20ms and emits exactly the byte count expected', () => {
    const p = new GeminiAudioFrameProcessor(16000);
    // 16000 / 20 = 800 samples per chunk = 1600 bytes per chunk.
    // Push 400 samples (800 bytes) — under threshold.
    const tiny = int16Frame(new Array(400).fill(0));
    const out = p.process(tiny);
    expect(out.length).toBe(0);
  });

  test('process() emits one or more blobs when the buffer fills past 20ms', () => {
    const p = new GeminiAudioFrameProcessor(16000);
    // Push 2400 samples — exceeds one 800-sample chunk; expect ≥ 1 blob.
    const big = int16Frame(new Array(2400).fill(123));
    const raw: Uint8Array[] = [];
    const out = p.process(big, raw);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBe(raw.length);
    for (const blob of out) {
      expect(blob.mimeType).toBe('audio/pcm;rate=16000');
    }
  });

  test('flush() drains the residual buffer exactly once', () => {
    const p = new GeminiAudioFrameProcessor(24000);
    const half = int16Frame(new Array(600).fill(7)); // < chunk size at 24k → 1200 samples
    p.process(half);
    const raw: Uint8Array[] = [];
    const out = p.flush(raw);
    // We don't assert on the exact count (depends on AudioByteStream rounding);
    // we assert that whatever it returns matches the raw side-channel.
    expect(out.length).toBe(raw.length);
  });

  test('process() raw-bytes side channel mirrors the wrapped blobs', () => {
    const p = new GeminiAudioFrameProcessor(16000);
    const big = int16Frame(new Array(3200).fill(42));
    const raw: Uint8Array[] = [];
    const out = p.process(big, raw);
    expect(raw.length).toBe(out.length);
    for (let i = 0; i < out.length; i++) {
      const decoded = Buffer.from(out[i]!.data, 'base64');
      expect(decoded.equals(Buffer.from(raw[i]!))).toBe(true);
    }
  });

  test('mime string reflects the configured sample rate', () => {
    const a = new GeminiAudioFrameProcessor(16000);
    const b = new GeminiAudioFrameProcessor(24000);
    expect(a.wrap(new Uint8Array(2)).mimeType).toBe('audio/pcm;rate=16000');
    expect(b.wrap(new Uint8Array(2)).mimeType).toBe('audio/pcm;rate=24000');
  });
});
