import { ResamplingAudioInput } from '@kuralle-agents/transport-base';
import type { RtpSession } from './rtp/rtp_session.js';

const RTP_SAMPLE_RATE = 8000;
const DEFAULT_OUTPUT_SAMPLE_RATE = 24000;

/**
 * Receives audio from an RTP stream and provides it as a
 * ReadableStream<AudioFrame> for the voice pipeline.
 *
 * RTP delivers G.711 at 8kHz. After decode, we upsample to the configured
 * output sample rate (default 24kHz, matching Twilio and other
 * transports). Cascaded callers can pass 16kHz for GeminiLiveSTT backward
 * compatibility.
 *
 * Resampler lifecycle + stream plumbing live in {@link ResamplingAudioInput}.
 * This subclass only wires the RTP session into the base's `ingestPcm`.
 */
export class SIPAudioInput extends ResamplingAudioInput {
  constructor(
    private rtpSession: RtpSession,
    sampleRate: number = RTP_SAMPLE_RATE,
    numChannels: number = 1,
    outputSampleRate: number = DEFAULT_OUTPUT_SAMPLE_RATE,
  ) {
    super({
      inputSampleRate: RTP_SAMPLE_RATE,
      outputSampleRate,
      numChannels,
    });
    void sampleRate;
    this.rtpSession.on('audio', (pcm: Int16Array) => this.ingestPcm(pcm));
  }
}
