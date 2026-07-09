import { AudioOutput, type AudioFrame } from '@kuralle-agents/livekit-plugin';
import type { WebSocket } from 'ws';

/**
 * Sends audio frames from the TTS pipeline to the WebSocket client
 * as binary messages containing raw PCM data.
 *
 * Designed to work with AgentSession without a LiveKit Room.
 */
export class WebSocketAudioOutput extends AudioOutput {
  private sendQueue: AudioFrame[] = [];
  private sending: boolean = false;
  private segmentSamplesSent: number = 0;
  private flushed: boolean = false;
  private closed: boolean = false;
  private segmentIndex = 0;
  private segmentStartedAt: number | null = null;
  private frameCountInSegment = 0;
  /** True after at least one captureFrame in the current segment. */
  private hasActiveSegment = false;

  constructor(
    private ws: WebSocket,
    private contextLabel: string = 'unknown',
    sampleRate: number = 24000,
  ) {
    super(sampleRate);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    if (this.closed) return;

    this.hasActiveSegment = true;
    await super.captureFrame(frame);

    if (this.closed) {
      this.finishSegment(true);
      return;
    }

    this.sendQueue.push(frame);

    if (!this.sending) {
      this.processSendQueue();
    }
  }

  private processSendQueue(): void {
    if (this.sending || this.closed) return;
    this.sending = true;
    this.drainAsync();
  }

  private drainAsync(): void {
    if (this.closed || this.sendQueue.length === 0) {
      this.sending = false;

      if (this.flushed) {
        this.finishSegment(false);
      }
      return;
    }

    const frame = this.sendQueue.shift()!;

    if (this.segmentSamplesSent === 0) {
      this.segmentIndex += 1;
      this.segmentStartedAt = Date.now();
      this.frameCountInSegment = 0;
      this.onPlaybackStarted(Date.now());
    }

    const buffer = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    try {
      this.ws.send(buffer, { binary: true });
    } catch {
      this.sending = false;
      this.finishSegment(true);
      return;
    }

    this.segmentSamplesSent += frame.samplesPerChannel;
    this.frameCountInSegment += 1;

    setImmediate(() => this.drainAsync());
  }

  flush(): void {
    // Do NOT call super.flush() here — it sets _capturing = false, which would
    // cause the base class to increment playbackSegmentsCount on the next
    // captureFrame() even if this segment hasn't finished draining yet.
    // finishSegment() calls super.flush() when the segment actually completes.
    this.flushed = true;

    if (this.sendQueue.length === 0) {
      this.finishSegment(false);
    }
  }

  clearBuffer(): void {
    this.sendQueue = [];
    this.finishSegment(true);
  }

  private finishSegment(interrupted: boolean): void {
    if (!this.hasActiveSegment) return;
    super.flush();

    const playbackDuration = this.sampleRate
      ? this.segmentSamplesSent / this.sampleRate
      : 0;

    super.onPlaybackFinished({
      playbackPosition: playbackDuration,
      interrupted,
    });
    this.resetSegment();
  }

  private resetSegment(): void {
    this.segmentSamplesSent = 0;
    this.flushed = false;
    this.hasActiveSegment = false;
    this.segmentStartedAt = null;
    this.frameCountInSegment = 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sendQueue = [];
    this.finishSegment(true);
  }
}
