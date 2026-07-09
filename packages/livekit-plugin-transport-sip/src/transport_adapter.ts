import { type TransportAdapterConfig } from '@kuralle-agents/livekit-plugin';
import { TransportAdapterBase } from '@kuralle-agents/transport-base';
import { SIPAudioInput } from './audio_input.js';
import { SIPAudioOutput } from './audio_output.js';
import { SIPTextOutput } from './text_output.js';
import type { RtpSession } from './rtp/rtp_session.js';
import type { Codec } from '@kuralle-agents/transport-base/codec/g711';

export class SIPTransportAdapter extends TransportAdapterBase {
  readonly audioInput: SIPAudioInput;
  readonly audioOutput: SIPAudioOutput;
  readonly textOutput: SIPTextOutput;
  readonly config: TransportAdapterConfig;

  private _rtpSession: RtpSession;

  constructor(
    rtpSession: RtpSession,
    codec: Codec,
    options: {
      id: string;
      packetDurationMs?: number;
      /**
       * Output sample rate for SIPAudioInput. Default 24kHz (matching
       * Twilio and all other transports). Pass 16000 for cascaded mode
       * with GeminiLiveSTT backward compatibility.
       */
      outputSampleRate?: number;
    },
  ) {
    super(options.id);

    this._rtpSession = rtpSession;
    const packetDurationMs = options.packetDurationMs ?? 20;
    const outputSampleRate = options.outputSampleRate ?? 24000;

    this.config = {
      sampleRate: outputSampleRate,
      numChannels: codec.channels,
      encoding: codec.name === 'PCMU' ? 'mulaw' : 'alaw',
      samplesPerChannel: (outputSampleRate * packetDurationMs) / 1000,
    };

    this.audioInput = new SIPAudioInput(
      rtpSession,
      codec.sampleRate,
      codec.channels,
      outputSampleRate,
    );
    this.audioOutput = new SIPAudioOutput(
      rtpSession,
      codec.sampleRate,
      packetDurationMs,
    );
    this.textOutput = new SIPTextOutput();
  }

  /** The underlying RTP session (for native bridge access). */
  get rtpSession(): RtpSession {
    return this._rtpSession;
  }

  protected override async onClose(): Promise<void> {
    this._rtpSession.close();
  }
}
