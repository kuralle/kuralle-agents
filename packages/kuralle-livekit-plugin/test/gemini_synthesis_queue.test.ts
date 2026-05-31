import { describe, test, expect } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { GeminiSynthesisQueue } from '../src/gemini/synthesis_queue.js';

initializeLogger({ pretty: false, level: 'warn' });

const b64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString('base64');

describe('GeminiSynthesisQueue', () => {
  test('ingest decodes base64 + accumulates byte total', () => {
    const q = new GeminiSynthesisQueue(24000);
    q.ingest(b64(new Array(40).fill(0)));
    expect(q.bytesReceived).toBe(40);
    q.ingest(b64(new Array(60).fill(0)));
    expect(q.bytesReceived).toBe(100);
  });

  test('frameCount tracks emitted frames across ingests', () => {
    const q = new GeminiSynthesisQueue(16000);
    // 16k mono: AudioByteStream chunks default frame; pump enough bytes to emit
    // at least one frame. 4800 bytes = 2400 samples.
    const big = b64(new Array(4800).fill(0));
    const frames = q.ingest(big);
    expect(q.frameCount).toBe(frames.length);
  });

  test('flush returns the residual buffer drained by AudioByteStream', () => {
    const q = new GeminiSynthesisQueue(24000);
    q.ingest(b64(new Array(100).fill(0)));
    const frames = q.flush();
    expect(Array.isArray(frames)).toBe(true);
  });

  test('empty ingest is a no-op', () => {
    const q = new GeminiSynthesisQueue(24000);
    const out = q.ingest('');
    expect(out.length).toBe(0);
    expect(q.bytesReceived).toBe(0);
  });
});
