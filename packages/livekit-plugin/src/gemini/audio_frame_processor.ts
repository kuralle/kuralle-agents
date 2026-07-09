import { AudioByteStream } from '@livekit/agents';

/**
 * Gemini realtime-input blob shape (`audio/pcm;rate=N` + base64 data).
 *
 * Defined here rather than re-imported from `stt.ts` so the processor has
 * no dependency on the STT module — bridges (other Gemini-powered audio
 * paths) can compose this processor without pulling in the STT class.
 */
export interface GeminiRealtimeBlob {
  data: string;
  mimeType: string;
}

interface PCMFrameLike {
  data: Int16Array;
}

/**
 * Pipeline that turns LiveKit `PCMFrame` chunks into Gemini-Live-ready
 * `audio/pcm;rate=N` base64 blobs.
 *
 * Lifted out of `gemini/stt.ts` so the buffering + base64 + blob-wrapping
 * concerns are unit-testable in isolation. The STT speech-stream now uses
 * this processor for both incoming frames and FLUSH-sentinel handling; the
 * resume-replay path on reconnect uses the same wrap helper.
 *
 * Buffers raw PCM into 20 ms (samplerate / 20) windows via
 * `@livekit/agents`' `AudioByteStream`. Calling `process(frame)` returns
 * zero or more wire-ready blobs; calling `flush()` returns whatever
 * remains plus a final blob so the caller can drain at end-of-stream.
 */
export class GeminiAudioFrameProcessor {
  readonly #sampleRate: number;
  readonly #stream: AudioByteStream;

  constructor(sampleRate: number, channels = 1) {
    this.#sampleRate = sampleRate;
    this.#stream = new AudioByteStream(sampleRate, channels, Math.floor(sampleRate / 20));
  }

  /** Wrap an already-PCM byte buffer in a Gemini realtime blob. */
  wrap(bytes: Uint8Array): GeminiRealtimeBlob {
    return {
      data: Buffer.from(bytes).toString('base64'),
      mimeType: `audio/pcm;rate=${this.#sampleRate}`,
    };
  }

  /**
   * Process a `PCMFrame` from the LiveKit input stream into one or more
   * Gemini-ready blobs. The 20 ms buffering means this commonly returns 0
   * or 1 blobs per call; the burst case returns more.
   *
   * `rawBytesOut`, when supplied, receives the PCM bytes that backed each
   * emitted blob — the STT speech stream uses that buffer to maintain its
   * resume-replay buffer (the 320-frame ring needed when Gemini drops the
   * WS mid-utterance and we have to resend).
   */
  process(frame: PCMFrameLike, rawBytesOut?: Uint8Array[]): GeminiRealtimeBlob[] {
    const pcm = normalizePcmBytes(frame);
    const out: GeminiRealtimeBlob[] = [];
    for (const chunk of this.#stream.write(toArrayBuffer(pcm))) {
      const bytes = new Uint8Array(
        Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength),
      );
      rawBytesOut?.push(bytes);
      out.push(this.wrap(bytes));
    }
    return out;
  }

  /**
   * Drain whatever remains in the underlying byte stream. Returns the
   * final blob list and (via `rawBytesOut`) the matching PCM bytes for
   * resume tracking.
   */
  flush(rawBytesOut?: Uint8Array[]): GeminiRealtimeBlob[] {
    const out: GeminiRealtimeBlob[] = [];
    for (const frame of this.#stream.flush()) {
      const bytes = new Uint8Array(
        Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
      );
      rawBytesOut?.push(bytes);
      out.push(this.wrap(bytes));
    }
    return out;
  }
}

function normalizePcmBytes(frame: PCMFrameLike): Uint8Array {
  const data = frame.data;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(buf);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
