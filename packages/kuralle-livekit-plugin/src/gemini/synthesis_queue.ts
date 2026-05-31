import { AudioByteStream } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

/**
 * Inbound-side audio assembly for the Gemini Live TTS path.
 *
 * Lifted out of `gemini/tts.ts` so the decode → 20-frame-buffer → final-flag
 * dance is unit-testable in isolation. Mirrors `GeminiAudioFrameProcessor`
 * on the STT side — same shape (per-instance buffer + drain) but reversed
 * direction (server → client).
 *
 * Behavior:
 *   - `ingest(base64Pcm)` decodes server-emitted base64 audio, buffers via
 *     `AudioByteStream(sampleRate, channels)`, and returns zero or more
 *     `AudioFrame`s ready to forward downstream.
 *   - `flush()` drains the residual buffer and yields any remaining frames.
 *   - `bytesReceived` exposes a running byte total for telemetry.
 *
 * The "last frame with `final: true`" semantics live in the speech stream
 * itself — the queue doesn't track which frame is the terminal one, since
 * that is a property of the stream's turn-completion signal, not the audio
 * pipeline.
 */
export class GeminiSynthesisQueue {
  readonly #stream: AudioByteStream;
  #bytesReceived = 0;
  #frameCount = 0;

  constructor(sampleRate: number, channels = 1) {
    this.#stream = new AudioByteStream(sampleRate, channels);
  }

  get bytesReceived(): number {
    return this.#bytesReceived;
  }

  get frameCount(): number {
    return this.#frameCount;
  }

  ingest(base64Pcm: string): AudioFrame[] {
    const pcmBytes = Buffer.from(base64Pcm, 'base64');
    this.#bytesReceived += pcmBytes.byteLength;
    const arr = toArrayBuffer(new Uint8Array(pcmBytes));
    const frames = [...this.#stream.write(arr)];
    this.#frameCount += frames.length;
    return frames;
  }

  flush(): AudioFrame[] {
    return [...this.#stream.flush()];
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
