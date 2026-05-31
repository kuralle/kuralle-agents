import { ResamplingAudioInput } from '@kuralle-agents/transport-base';
import { mulawDecodeArray } from '@kuralle-agents/transport-base/codec/g711';
import type { TwilioMediaEvent } from './twilio_protocol.js';

const TWILIO_SAMPLE_RATE = 8000;
const TARGET_SAMPLE_RATE = 24000;

/**
 * Receives audio from Twilio Media Streams and provides it as a
 * ReadableStream<AudioFrame> for the STT pipeline.
 *
 * Flow:
 * 1. Twilio sends mu-law audio at 8kHz (base64 encoded)
 * 2. Decode mu-law to PCM Int16
 * 3. Delegate to ResamplingAudioInput.ingestPcm (8kHz → 24kHz upsample)
 */
export class TwilioAudioInput extends ResamplingAudioInput {
  constructor() {
    super({
      inputSampleRate: TWILIO_SAMPLE_RATE,
      outputSampleRate: TARGET_SAMPLE_RATE,
    });
  }

  handleMediaEvent(event: TwilioMediaEvent): void {
    const payload = event.media.payload;
    if (!payload) return;

    try {
      const mulawData = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const pcm8kHz = mulawDecodeArray(mulawData);
      this.ingestPcm(pcm8kHz);
    } catch (error) {
      console.error('[TwilioAudioInput] Error processing media event:', {
        error: error instanceof Error ? error.message : String(error),
        payloadLength: payload.length,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /** End the current audio stream; the base resets its resampler state. */
  endCurrentStreamPublic(): void {
    this.endCurrentStream();
  }
}
