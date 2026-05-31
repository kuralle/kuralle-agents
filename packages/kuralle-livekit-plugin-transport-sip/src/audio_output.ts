import { AudioOutput, AudioFrame } from '@kuralle-agents/livekit-plugin';
import { createResampler } from '@kuralle-agents/livekit-plugin/utils/resample';
import type { RtpSession } from './rtp/rtp_session.js';

const TTS_SAMPLE_RATE = 24000;
const RTP_SAMPLE_RATE = 8000;

/**
 * Sends audio frames from the TTS pipeline to the caller as RTP packets
 * at real-time pace (setInterval at packet duration).
 *
 * TTS emits 24kHz AudioFrames. We downsample to 8kHz before RTP packetization.
 *
 * **Frame accumulation (sip-to-ai `AudioAdapter.feed_ai_audio`):** resampled PCM
 * is merged in `accumulator` until a full 20ms frame exists; remainders are kept
 * (no padding between chunks). Flush pads only the final partial frame.
 *
 * The resampler is allocated once and reused across all frames
 * for the lifetime of this output (Sox sinc via local Rust FFI).
 */
export class SIPAudioOutput extends AudioOutput {
  private sendQueue: Int16Array[] = [];
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private segmentSamplesSent: number = 0;
  private flushed: boolean = false;
  private closed: boolean = false;
  private samplesPerPacket: number;
  private packetIntervalMs: number;
  private resampler = createResampler(TTS_SAMPLE_RATE, RTP_SAMPLE_RATE);

  constructor(
    private rtpSession: RtpSession,
    sampleRate: number = RTP_SAMPLE_RATE,
    packetDurationMs: number = 20,
  ) {
    super(sampleRate);
    this.packetIntervalMs = packetDurationMs;
    this.samplesPerPacket = (sampleRate * packetDurationMs) / 1000;
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    if (this.closed) return;

    if (this.segmentSamplesSent === 0) {
      this.onPlaybackStarted(Date.now());
      this.startSendTimer();
    }

    // Push 24kHz frame through the streaming resampler -> 8kHz frames
    for (const outFrame of this.resampler.push(frame)) {
      this.sendQueue.push(new Int16Array(outFrame.data));
    }
  }

  private startSendTimer(): void {
    if (this.sendTimer) return;

    let accumulator = new Int16Array(0);

    this.sendTimer = setInterval(() => {
      if (this.closed) {
        this.stopSendTimer();
        return;
      }

      // Merge accumulator with queued chunks
      while (
        accumulator.length < this.samplesPerPacket &&
        this.sendQueue.length > 0
      ) {
        const next = this.sendQueue.shift()!;
        const merged = new Int16Array(accumulator.length + next.length);
        merged.set(accumulator);
        merged.set(next, accumulator.length);
        accumulator = merged;
      }

      if (accumulator.length >= this.samplesPerPacket) {
        const packet = accumulator.slice(0, this.samplesPerPacket);
        accumulator = accumulator.slice(this.samplesPerPacket);

        this.rtpSession.sendAudio(packet);
        this.segmentSamplesSent += this.samplesPerPacket;
      } else if (this.flushed && this.sendQueue.length === 0) {
        this.stopSendTimer();

        // Send any remaining partial packet padded with silence
        if (accumulator.length > 0) {
          const padded = new Int16Array(this.samplesPerPacket);
          padded.set(accumulator);
          this.rtpSession.sendAudio(padded);
          this.segmentSamplesSent += accumulator.length;
          accumulator = new Int16Array(0);
        }

        const playbackDuration = this.sampleRate
          ? this.segmentSamplesSent / this.sampleRate
          : 0;

        this.onPlaybackFinished({
          playbackPosition: playbackDuration,
          interrupted: false,
        });

        this.segmentSamplesSent = 0;
        this.flushed = false;
      }
    }, this.packetIntervalMs);
  }

  private stopSendTimer(): void {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
  }

  flush(): void {
    super.flush();

    // Drain any buffered samples from the resampler
    for (const outFrame of this.resampler.flush()) {
      this.sendQueue.push(new Int16Array(outFrame.data));
    }

    this.flushed = true;

    if (this.segmentSamplesSent === 0 && this.sendQueue.length === 0) {
      this.onPlaybackFinished({
        playbackPosition: 0,
        interrupted: false,
      });
      this.flushed = false;
    }
  }

  clearBuffer(): void {
    const playbackDuration = this.sampleRate
      ? this.segmentSamplesSent / this.sampleRate
      : 0;

    this.sendQueue = [];
    this.stopSendTimer();

    this.onPlaybackFinished({
      playbackPosition: playbackDuration,
      interrupted: true,
    });

    this.segmentSamplesSent = 0;
    this.flushed = false;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopSendTimer();
    this.sendQueue = [];
  }
}
