import {
  type TransportAdapterConfig,
  type AudioEncoding,
} from '@kuralle-agents/livekit-plugin';
import { TransportAdapterBase } from '@kuralle-agents/transport-base';
import type { WebSocket } from 'ws';
import { WebSocketAudioInput } from './audio_input.js';
import { WebSocketAudioOutput } from './audio_output.js';
import { createWebSocketTextOutput } from './text_output.js';

/**
 * Bundles WebSocket I/O implementations into a single TransportAdapter.
 *
 * Idempotent close + listener registry + random id come from
 * {@link TransportAdapterBase}. The subclass wires WebSocket `close` /
 * `error` events into the base's close() so the agent pipeline sees a
 * clean shutdown when the client disconnects.
 */
export class WebSocketTransportAdapter extends TransportAdapterBase {
  readonly audioInput: WebSocketAudioInput;
  readonly audioOutput: WebSocketAudioOutput;
  readonly textOutput: import('@kuralle-agents/livekit-plugin').TextOutput;
  readonly config: TransportAdapterConfig;

  /**
   * Access the underlying WebSocket for raw I/O operations.
   *
   * Used by the realtime bridge (realtime_bridge.ts) and
   * startNativeSession() to attach binary audio listeners
   * directly on the socket without going through AudioInput/AudioOutput.
   */
  get rawSocket(): WebSocket {
    return this.ws;
  }

  constructor(
    private ws: WebSocket,
    options: {
      id?: string;
      sampleRate?: number;
      numChannels?: number;
      encoding?: AudioEncoding;
    } = {},
  ) {
    super(options.id);

    const sampleRate = options.sampleRate ?? 24000;
    const numChannels = options.numChannels ?? 1;
    const encoding = options.encoding ?? 'pcm_s16le';

    this.config = {
      sampleRate,
      numChannels,
      encoding,
      samplesPerChannel: null,
    };

    this.audioInput = new WebSocketAudioInput(ws, sampleRate, numChannels);
    this.audioOutput = new WebSocketAudioOutput(ws, this.id, sampleRate);
    this.textOutput = createWebSocketTextOutput(ws, this.id);

    ws.on('close', () => {
      if (this.isOpen) void this.close();
    });

    ws.on('error', (err) => {
      console.error('[WebSocketTransport] WebSocket error:', err.message);
      this.emitError(err instanceof Error ? err : new Error(String(err)));
      if (this.isOpen) void this.close();
    });
  }

  protected override async onClose(): Promise<void> {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.close(1000, 'Session ended');
    }
  }

  /**
   * `emitError` is `protected` on the base. We expose it here (still
   * package-visible, never on the public TransportAdapter surface) so the
   * WebSocket server code paths that synthesize errors without having a
   * throw-site can forward them through the adapter's event channel.
   */
  public raiseError(err: Error): void {
    this.emitError(err);
  }
}
