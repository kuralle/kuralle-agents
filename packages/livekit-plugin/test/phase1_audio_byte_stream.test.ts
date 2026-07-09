import { describe, expect, it } from 'bun:test';
import { AudioByteStream } from '../src/audio_byte_stream.js';

describe('AudioByteStream samplesPerChannel calculation', () => {
  it('mono: samplesPerChannel equals total samples', () => {
    const stream = new AudioByteStream(8000, 1, 4); // 4 samples per channel
    const bytesPerFrame = 1 * 4 * 2; // numChannels * samplesPerChannel * 2
    const data = new ArrayBuffer(bytesPerFrame);

    const frames = stream.write(data);
    expect(frames.length).toBe(1);
    expect(frames[0].samplesPerChannel).toBe(4);
    expect(frames[0].channels).toBe(1);
  });

  it('stereo: samplesPerChannel is half of total samples', () => {
    const stream = new AudioByteStream(8000, 2, 4); // 4 samples per channel, 2 channels
    const bytesPerFrame = 2 * 4 * 2; // numChannels * samplesPerChannel * 2
    const data = new ArrayBuffer(bytesPerFrame);

    const frames = stream.write(data);
    expect(frames.length).toBe(1);
    // The fix: samplesPerChannel should be 4 (not 8)
    expect(frames[0].samplesPerChannel).toBe(4);
    expect(frames[0].channels).toBe(2);
  });

  it('flush: mono samplesPerChannel is correct', () => {
    const stream = new AudioByteStream(8000, 1, 100); // large frame size
    // Write less than a full frame
    const data = new ArrayBuffer(10); // 5 samples mono
    stream.write(data);

    const frames = stream.flush();
    expect(frames.length).toBe(1);
    expect(frames[0].samplesPerChannel).toBe(5);
  });

  it('flush: stereo samplesPerChannel is correct', () => {
    const stream = new AudioByteStream(8000, 2, 100);
    // Write 8 bytes = 4 total samples = 2 per channel
    const data = new ArrayBuffer(8);
    stream.write(data);

    const frames = stream.flush();
    expect(frames.length).toBe(1);
    expect(frames[0].samplesPerChannel).toBe(2);
    expect(frames[0].channels).toBe(2);
  });

  it('flush: returns empty if buffer is not sample-aligned', () => {
    const stream = new AudioByteStream(8000, 2, 100);
    // Write 3 bytes -- not aligned to 2*2=4 bytes per sample pair
    const data = new ArrayBuffer(3);
    stream.write(data);

    const frames = stream.flush();
    expect(frames.length).toBe(0);
  });
});
