import { AudioFrame } from './audio_frame.js';

/**
 * Accumulates raw PCM bytes and produces AudioFrame objects when enough
 * data has been buffered for a complete frame.
 *
 * This is the primary utility for transport adapters that receive audio
 * as a continuous byte stream (WebSocket binary messages, RTP packets,
 * HTTP chunked transfer, etc.).
 *
 * The default frame size is 100ms of audio (sampleRate / 10 samples).
 */
export class AudioByteStream {
  private sampleRate: number;
  private numChannels: number;
  private bytesPerFrame: number;
  private buf: Int8Array;

  constructor(
    sampleRate: number,
    numChannels: number,
    samplesPerChannel: number | null = null,
  ) {
    this.sampleRate = sampleRate;
    this.numChannels = numChannels;

    if (samplesPerChannel === null) {
      samplesPerChannel = Math.floor(sampleRate / 10);
    }

    this.bytesPerFrame = numChannels * samplesPerChannel * 2;
    this.buf = new Int8Array();
  }

  /**
   * Write raw PCM bytes. Returns zero or more complete AudioFrame objects.
   * Incomplete data is buffered internally.
   */
  write(data: ArrayBuffer): AudioFrame[] {
    const incoming = new Int8Array(data);
    const next = new Int8Array(this.buf.length + incoming.length);
    next.set(this.buf, 0);
    next.set(incoming, this.buf.length);
    this.buf = next;

    const frames: AudioFrame[] = [];
    while (this.buf.length >= this.bytesPerFrame) {
      const frameData = this.buf.slice(0, this.bytesPerFrame);
      this.buf = this.buf.slice(this.bytesPerFrame);

      frames.push(
        new AudioFrame(
          new Int16Array(frameData.buffer),
          this.sampleRate,
          this.numChannels,
          frameData.length / (2 * this.numChannels),
        ),
      );
    }

    return frames;
  }

  /**
   * Flush remaining buffered data as a final (potentially short) frame.
   * Returns empty array if remaining buffer is not sample-aligned.
   */
  flush(): AudioFrame[] {
    if (this.buf.length === 0) {
      return [];
    }

    if (this.buf.length % (2 * this.numChannels) !== 0) {
      return [];
    }

    const frames = [
      new AudioFrame(
        new Int16Array(this.buf.buffer),
        this.sampleRate,
        this.numChannels,
        this.buf.length / (2 * this.numChannels),
      ),
    ];

    this.buf = new Int8Array();
    return frames;
  }
}
