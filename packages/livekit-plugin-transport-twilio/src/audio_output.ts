import type { AudioFrame } from '@kuralle-agents/livekit-plugin';
import { ResamplingAudioOutput } from '@kuralle-agents/transport-base';
import { mulawEncodeArray } from '@kuralle-agents/transport-base/codec/g711';

const TTS_SAMPLE_RATE = 24000;
const TARGET_SAMPLE_RATE = 8000;

/**
 * Sends audio frames from the TTS pipeline to Twilio Media Streams.
 *
 * Flow (inherited from {@link ResamplingAudioOutput}):
 * 1. TTS pipeline feeds AudioFrame at 24kHz via captureFrame
 * 2. Base resamples 24kHz → 8kHz AudioFrame
 * 3. This subclass's deliverFrame() encodes mu-law, base64, JSON-frames
 *    it, and calls the send callback
 *
 * Twilio handles pacing on the peer side, so no timer is needed here.
 */
export class TwilioAudioOutput extends ResamplingAudioOutput {
  private sendCallback: (message: string) => void = () => {};

  constructor() {
    super({
      inputSampleRate: TTS_SAMPLE_RATE,
      outputSampleRate: TARGET_SAMPLE_RATE,
    });
  }

  setSendCallback(callback: (message: string) => void): void {
    this.sendCallback = callback;
  }

  protected override deliverFrame(frame: AudioFrame): void {
    if (this.isClosed) return;
    const mulawData = mulawEncodeArray(new Int16Array(frame.data));
    const base64 = Buffer.from(mulawData).toString('base64');

    const message = JSON.stringify({
      event: 'media',
      streamSid: '',
      sequenceNumber: `${Date.now()}`,
      media: {
        payload: base64,
      },
    });

    this.sendCallback(message);
  }

  protected override onClearBuffer(): void {
    try {
      this.sendCallback(
        JSON.stringify({
          event: 'clear',
          streamSid: '',
          sequenceNumber: `${Date.now()}`,
        }),
      );
    } catch (error) {
      console.error('[TwilioAudioOutput] Error sending clear message:', {
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }
}
