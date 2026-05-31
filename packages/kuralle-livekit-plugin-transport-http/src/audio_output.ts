import { AudioOutput, type AudioFrame } from '@kuralle-agents/livekit-plugin';
import type { SSEWriter, AgentAudioEvent } from './sse.js';

/**
 * Sends audio frames from the TTS pipeline to the client as SSE events
 * containing base64-encoded PCM audio.
 */
export class HTTPAudioOutput extends AudioOutput {
  private segmentSamplesSent: number = 0;
  private closed: boolean = false;
  private sseWriter: SSEWriter | null = null;

  constructor(sampleRate: number = 24000) {
    super(sampleRate);
  }

  setSSEWriter(writer: SSEWriter): void {
    this.sseWriter = writer;
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    if (this.closed || !this.sseWriter) return;

    if (this.segmentSamplesSent === 0) {
      this.onPlaybackStarted(Date.now());
    }

    const bytes = new Uint8Array(frame.data.buffer);
    const base64 = Buffer.from(bytes).toString('base64');

    const event: AgentAudioEvent = {
      audio: base64,
      sampleRate: frame.sampleRate,
      numChannels: frame.channels,
    };

    this.sseWriter.writeEvent('agent_audio', event);
    this.segmentSamplesSent += frame.samplesPerChannel;
  }

  flush(): void {
    super.flush();

    const playbackDuration = this.sampleRate
      ? this.segmentSamplesSent / this.sampleRate
      : 0;

    this.onPlaybackFinished({
      playbackPosition: playbackDuration,
      interrupted: false,
    });

    this.segmentSamplesSent = 0;
  }

  clearBuffer(): void {
    const playbackDuration = this.sampleRate
      ? this.segmentSamplesSent / this.sampleRate
      : 0;

    this.onPlaybackFinished({
      playbackPosition: playbackDuration,
      interrupted: true,
    });

    this.segmentSamplesSent = 0;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
