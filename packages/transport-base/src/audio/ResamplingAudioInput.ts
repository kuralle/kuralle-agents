import { TransformStream } from 'node:stream/web';
import {
  AudioInput,
  AudioFrame,
} from '@kuralle-agents/livekit-plugin';
import { createResampler } from '@kuralle-agents/livekit-plugin/utils/resample';
import type { AudioResampler } from '@livekit/rtc-node';

export interface ResamplingAudioInputOptions {
  inputSampleRate: number;
  outputSampleRate: number;
  numChannels?: number;
}

/**
 * Abstract base for transport AudioInputs that receive PCM at one rate and
 * need to deliver frames at another. Subclasses wire their source (RTP
 * callback, WebSocket media event, UDP datagram…) to {@link ingestPcm} and
 * optionally start new logical streams via {@link startNewStream} /
 * {@link endCurrentStream}.
 *
 * Extracted to remove the duplicate resampler lifecycle / TransformStream
 * plumbing currently copied across sip, twilio, and (smaller variants)
 * inside ws / http / smartpbx.
 */
export abstract class ResamplingAudioInput extends AudioInput {
  protected readonly inputSampleRate: number;
  protected readonly outputSampleRate: number;
  protected readonly numChannels: number;

  private resampler: AudioResampler;
  private writer: WritableStreamDefaultWriter<AudioFrame> | null = null;
  private currentStreamId: string | null = null;
  private closed = false;

  constructor(options: ResamplingAudioInputOptions) {
    super();
    this.inputSampleRate = options.inputSampleRate;
    this.outputSampleRate = options.outputSampleRate;
    this.numChannels = options.numChannels ?? 1;
    this.resampler = createResampler(
      this.inputSampleRate,
      this.outputSampleRate,
      this.numChannels,
    );
  }

  /** Open a new logical stream. Called automatically by ingestPcm when needed. */
  protected startNewStream(): string {
    if (this.currentStreamId) return this.currentStreamId;
    const { readable, writable } = new TransformStream<AudioFrame>();
    this.writer = writable.getWriter();
    this.currentStreamId = this.multiStream.addInputStream(readable);
    return this.currentStreamId;
  }

  /**
   * Close the current logical stream (flushing any remaining resampler
   * samples first) and reset the resampler so the next stream starts clean.
   */
  protected endCurrentStream(): void {
    if (!this.writer) {
      this.currentStreamId = null;
      return;
    }

    for (const frame of this.resampler.flush()) {
      this.writer.write(frame).catch(() => {});
    }

    this.writer.close().catch(() => {});
    this.writer = null;
    this.currentStreamId = null;

    // Fresh resampler per stream so per-stream filter state does not bleed.
    this.resampler = createResampler(
      this.inputSampleRate,
      this.outputSampleRate,
      this.numChannels,
    );
  }

  /**
   * Feed PCM at `inputSampleRate`. Subclasses call this from their data
   * source handler. Frames emitted by the resampler at `outputSampleRate`
   * are written to the downstream consumer (STT pipeline).
   *
   * Opens a new stream lazily on first call. If `startNewStream` is
   * explicitly preferred (e.g. Twilio's start/stop events), subclasses can
   * call it first and then call `ingestPcm`.
   */
  protected ingestPcm(pcm: Int16Array): void {
    if (this.closed) return;

    const inputFrame = new AudioFrame(
      pcm,
      this.inputSampleRate,
      this.numChannels,
      pcm.length / this.numChannels,
    );

    const outputs = this.resampler.push(inputFrame);
    if (outputs.length === 0) return;

    if (!this.writer) this.startNewStream();
    const w = this.writer;
    if (!w) return;

    for (const frame of outputs) {
      w.write(frame).catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.endCurrentStream();
    await super.close();
  }
}
