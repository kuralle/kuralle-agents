/**
 * Twilio Media Streams Transport Adapter.
 *
 * Connects Kuralle agents to Twilio Media Streams for telephony voice AI
 * applications. Works in Cloudflare Workers, Node.js, and any runtime
 * with WebSocket support.
 *
 * Twilio sends G.711 μ-law audio at 8kHz. Decoding and resampling to
 * 24kHz live in the `ResamplingAudioInput` base in `@kuralle-agents/
 * transport-base`; this adapter just wires the Twilio event dispatcher
 * into its I/O triplet.
 */

import type {
  AudioEncoding,
  TransportAdapterConfig,
} from '@kuralle-agents/livekit-plugin';
import { TransportAdapterBase } from '@kuralle-agents/transport-base';
import { TwilioAudioInput } from './audio_input.js';
import { TwilioAudioOutput } from './audio_output.js';
import { TwilioTextOutput } from './text_output.js';

export interface TwilioTransportOptions {
  id?: string;
  /**
   * Callback to send messages to the WebSocket. The transport formats
   * messages as Twilio Media Streams events before invoking this.
   */
  send: (message: string) => void;
}

export class TwilioTransportAdapter extends TransportAdapterBase {
  readonly audioInput: TwilioAudioInput;
  readonly audioOutput: TwilioAudioOutput;
  readonly textOutput: import('@kuralle-agents/livekit-plugin').TextOutput;
  readonly config: TransportAdapterConfig;

  private _streamSid: string = '';
  private _twilioTextOutput: TwilioTextOutput;

  constructor(options: TwilioTransportOptions) {
    super(options.id);

    this.config = {
      sampleRate: 24000,
      numChannels: 1,
      encoding: 'pcm_s16le' as AudioEncoding,
      samplesPerChannel: 2400,
    };

    this.audioInput = new TwilioAudioInput();
    this.audioOutput = new TwilioAudioOutput();
    this._twilioTextOutput = new TwilioTextOutput();
    this.textOutput = this._twilioTextOutput.output;

    this.audioOutput.setSendCallback((message) => {
      const event = JSON.parse(message);
      event.streamSid = this._streamSid;
      options.send(JSON.stringify(event));
    });
    this._twilioTextOutput.setSendCallback((markName) => {
      options.send(
        JSON.stringify({
          event: 'mark',
          streamSid: this._streamSid,
          sequenceNumber: `${Date.now()}`,
          mark: { name: markName },
        }),
      );
    });
  }

  get streamSid(): string {
    return this._streamSid;
  }

  /**
   * Handle an incoming message from Twilio. Call this for each WebSocket
   * message received from Twilio.
   */
  handleMessage(message: string): void {
    try {
      const event = JSON.parse(message);

      switch (event.event) {
        case 'media':
          this.audioInput.handleMediaEvent(event);
          break;

        case 'connected':
          console.log('[TwilioTransport] Connected to Twilio Media Streams');
          break;

        case 'start':
          this._streamSid = event.start?.streamSid || event.streamSid || '';
          console.log('[TwilioTransport] Stream started:', {
            streamSid: this._streamSid,
            callSid: event.start?.callSid,
            tracks: event.start?.tracks,
          });
          break;

        case 'stop':
        case 'disconnected':
          console.log('[TwilioTransport] Stream ended:', this._streamSid);
          this.audioInput.endCurrentStreamPublic();
          this._streamSid = '';
          void this.close();
          break;

        case 'clear':
          console.log('[TwilioTransport] Clear audio buffer requested');
          this.audioOutput.clearBuffer();
          break;

        case 'mark':
          console.log('[TwilioTransport] Received mark:', event.mark?.name);
          break;

        default:
          console.log('[TwilioTransport] Unknown event:', event.event);
      }
    } catch (error) {
      console.error('[TwilioTransport] Error handling message:', {
        error: error instanceof Error ? error.message : String(error),
        transportId: this.id,
        timestamp: new Date().toISOString(),
      });
    }
  }

  clearAudio(): void {
    this.audioOutput.clearBuffer();
  }
}
