import { AudioOutput, AudioFrame } from '@kuralle-agents/livekit-plugin';
import { createResampler } from '@kuralle-agents/livekit-plugin/utils/resample';
import type { AudioResampler } from '@livekit/rtc-node';

export interface PlaybackSegmentEvent {
  playbackPosition: number;
  interrupted: boolean;
}

export interface ResamplingAudioOutputOptions {
  /** TTS-side sample rate feeding this output. */
  inputSampleRate: number;
  /** Wire-side sample rate delivered to the subclass via {@link deliverFrame}. */
  outputSampleRate: number;
  numChannels?: number;
}

/**
 * Abstract base for transport AudioOutputs that resample TTS frames to the
 * wire format, deliver them, and manage the segment lifecycle
 * (`onPlaybackStarted` / `onPlaybackFinished`). Subclasses override
 * {@link deliverFrame} to do the actual send.
 *
 * Pacing (SIP's 20ms RTP timer) is orthogonal and stays in the subclass — see
 * SIPAudioOutput — because imposing a timer in the base would break Twilio
 * (which relies on the peer for pacing) and HTTP (SSE send-and-forget).
 */
export abstract class ResamplingAudioOutput extends AudioOutput {
  protected readonly inputSampleRate: number;
  protected readonly outputSampleRate: number;
  protected readonly numChannels: number;

  private resampler: AudioResampler;
  private closed = false;
  private flushed = false;
  private segmentSamplesSent = 0;

  constructor(options: ResamplingAudioOutputOptions) {
    super(options.outputSampleRate);
    this.inputSampleRate = options.inputSampleRate;
    this.outputSampleRate = options.outputSampleRate;
    this.numChannels = options.numChannels ?? 1;
    this.resampler = createResampler(
      this.inputSampleRate,
      this.outputSampleRate,
      this.numChannels,
    );
  }

  /**
   * Deliver a single resampled frame at `outputSampleRate`. Subclass must
   * implement the actual wire send. Throwing is fine — the base catches and
   * logs via console.error but does not propagate (matches twilio/http
   * behavior pre-refactor). Return value ignored.
   */
  protected abstract deliverFrame(frame: AudioFrame): void | Promise<void>;

  /**
   * Optional hook — subclass can send an explicit "clear / interrupt"
   * signal when {@link clearBuffer} runs (used by Twilio).
   */
  protected onClearBuffer(): void {
    // default no-op
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    if (this.closed) return;

    if (this.segmentSamplesSent === 0) {
      this.onPlaybackStarted(Date.now());
    }

    for (const outFrame of this.resampler.push(frame)) {
      try {
        const maybePromise = this.deliverFrame(outFrame);
        if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
          await maybePromise;
        }
      } catch (err) {
        console.error('[ResamplingAudioOutput] deliverFrame error:', {
          error: err instanceof Error ? err.message : String(err),
          samplesPerChannel: outFrame.samplesPerChannel,
          timestamp: new Date().toISOString(),
        });
        break;
      }
      this.segmentSamplesSent += outFrame.samplesPerChannel;
    }

    if (this.flushed) this.finalizeSegmentIfDone();
  }

  flush(): void {
    super.flush();

    for (const outFrame of this.resampler.flush()) {
      try {
        void this.deliverFrame(outFrame);
      } catch {
        // swallow
      }
      this.segmentSamplesSent += outFrame.samplesPerChannel;
    }

    this.flushed = true;
    this.finalizeSegmentIfDone();
  }

  private finalizeSegmentIfDone(): void {
    if (!this.flushed) return;
    const rate = this.outputSampleRate || this.sampleRate || 1;
    const playbackDuration = this.segmentSamplesSent / rate;
    this.onPlaybackFinished({
      playbackPosition: playbackDuration,
      interrupted: false,
    });
    this.segmentSamplesSent = 0;
    this.flushed = false;
  }

  clearBuffer(): void {
    const rate = this.outputSampleRate || this.sampleRate || 1;
    const playbackDuration = this.segmentSamplesSent / rate;

    this.onPlaybackFinished({
      playbackPosition: playbackDuration,
      interrupted: true,
    });

    this.segmentSamplesSent = 0;
    this.flushed = false;

    try {
      this.onClearBuffer();
    } catch (err) {
      console.error('[ResamplingAudioOutput] onClearBuffer error:', {
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
