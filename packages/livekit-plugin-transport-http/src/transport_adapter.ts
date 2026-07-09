import { type TransportAdapterConfig } from '@kuralle-agents/livekit-plugin';
import { TransportAdapterBase } from '@kuralle-agents/transport-base';
import { HTTPAudioInput } from './audio_input.js';
import { HTTPAudioOutput } from './audio_output.js';
import { HTTPTextOutput } from './text_output.js';
import type { SSEWriter } from './sse.js';

export class HTTPTransportAdapter extends TransportAdapterBase {
  readonly audioInput: HTTPAudioInput;
  readonly audioOutput: HTTPAudioOutput;
  readonly textOutput: import('@kuralle-agents/livekit-plugin').TextOutput;
  readonly config: TransportAdapterConfig;

  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimeout: number;
  private _httpTextOutput: HTTPTextOutput;

  constructor(
    options: {
      id?: string;
      sampleRate?: number;
      numChannels?: number;
      sessionTimeout?: number;
    } = {},
  ) {
    super(options.id);

    const sampleRate = options.sampleRate ?? 24000;
    const numChannels = options.numChannels ?? 1;
    this.sessionTimeout = options.sessionTimeout ?? 300000;

    this.config = {
      sampleRate,
      numChannels,
      encoding: 'pcm_s16le',
      samplesPerChannel: null,
    };

    this.audioInput = new HTTPAudioInput(sampleRate, numChannels);
    this.audioOutput = new HTTPAudioOutput(sampleRate);
    this._httpTextOutput = new HTTPTextOutput();
    this.textOutput = this._httpTextOutput.output;

    this.timeoutTimer = setTimeout(() => {
      void this.close();
    }, this.sessionTimeout);
  }

  /** Attach SSE writer to audio and text outputs. */
  attachSSE(writer: SSEWriter): void {
    this.audioOutput.setSSEWriter(writer);
    this._httpTextOutput.setSSEWriter(writer);
  }

  /** Reset session timeout on activity. */
  touch(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = setTimeout(() => {
        void this.close();
      }, this.sessionTimeout);
    }
  }

  protected override async onClose(): Promise<void> {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }
}
