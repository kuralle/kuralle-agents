import {
  AudioByteStream,
  AudioInput,
  AudioOutput,
  isTimedString,
  TextOutput,
  type AudioFrame,
  type TimedString,
} from '@kuralle-agents/livekit-plugin';
import { TransportAdapterBase } from '@kuralle-agents/transport-base';
import { TransformStream } from 'node:stream/web';
import type {
  SmartPBXSessionState,
  SmartPBXSocketLike,
  SmartPBXTransportAdapterOptions,
} from './types.js';
import {
  DEFAULT_SMARTPBX_SAMPLE_RATE,
  DEFAULT_WEBSOCKET_OPEN_STATE,
} from './types.js';

function isSocketOpen(socket: SmartPBXSocketLike, websocketOpenState: number): boolean {
  return socket.readyState === websocketOpenState;
}

export class SmartPBXAudioInput extends AudioInput {
  private byteStream: AudioByteStream;
  private currentStreamId: string | null = null;
  private streamWriter: WritableStreamDefaultWriter<AudioFrame> | null = null;

  constructor(
    private session: SmartPBXSessionState,
    private sampleRate: number,
  ) {
    super();
    this.byteStream = new AudioByteStream(sampleRate, 1);
  }

  pushSmartPBXFrame(frame: Float32Array): void {
    if (!this.session.isActive) {
      return;
    }

    if (!this.currentStreamId) {
      const { readable, writable } = new TransformStream<AudioFrame>();
      this.streamWriter = writable.getWriter();
      this.currentStreamId = this.multiStream.addInputStream(readable);
    }

    const pcm16 = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const sample = Math.max(-1, Math.min(1, frame[i] ?? 0));
      pcm16[i] = sample * 0x7fff;
    }

    const frames = this.byteStream.write(pcm16.buffer.slice(0));
    for (const nextFrame of frames) {
      this.streamWriter?.write(nextFrame).catch((error) => {
        console.error('[SmartPBXAudioInput] Failed to write frame:', error);
      });
    }
  }

  endCurrentTurn(): void {
    const pending = this.byteStream.flush();
    for (const nextFrame of pending) {
      this.streamWriter?.write(nextFrame).catch((error) => {
        console.error('[SmartPBXAudioInput] Failed to write flush frame:', error);
      });
    }

    this.streamWriter?.close().catch((error) => {
      console.error('[SmartPBXAudioInput] Failed to close writer:', error);
    });

    this.streamWriter = null;
    this.currentStreamId = null;
  }

  override async close(): Promise<void> {
    if (this.streamWriter) {
      await this.streamWriter.close().catch((error) => {
        console.error('[SmartPBXAudioInput] Failed to close writer during cleanup:', error);
      });
    }

    this.streamWriter = null;
    this.currentStreamId = null;
    await super.close();
  }
}

export class SmartPBXAudioOutput extends AudioOutput {
  private playing = false;
  private segmentSamplesSent = 0;

  constructor(
    private socket: SmartPBXSocketLike,
    private session: SmartPBXSessionState,
    private websocketOpenState: number,
    private onAudioFrame?: (frame: Float32Array, session: SmartPBXSessionState) => void,
    sampleRate: number = DEFAULT_SMARTPBX_SAMPLE_RATE,
  ) {
    super(sampleRate);
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);

    if (!this.onAudioFrame) {
      return;
    }

    if (!this.session.isActive || !isSocketOpen(this.socket, this.websocketOpenState)) {
      return;
    }

    const float32 = new Float32Array(frame.data.length);
    for (let i = 0; i < frame.data.length; i++) {
      float32[i] = frame.data[i] / 32768.0;
    }

    this.onAudioFrame(float32, this.session);

    if (!this.playing) {
      this.playing = true;
      this.segmentSamplesSent = 0;
      this.onPlaybackStarted(Date.now());
    }

    this.segmentSamplesSent += frame.samplesPerChannel;
  }

  override clearBuffer(): void {
    if (this.playing) {
      this.playing = false;
      this.onPlaybackFinished({
        playbackPosition: this.sampleRate ? this.segmentSamplesSent / this.sampleRate : 0,
        interrupted: true,
      });
      this.segmentSamplesSent = 0;
    }
  }

  override flush(): void {
    super.flush();
    if (this.playing) {
      this.playing = false;
      this.onPlaybackFinished({
        playbackPosition: this.sampleRate ? this.segmentSamplesSent / this.sampleRate : 0,
        interrupted: false,
      });
      this.segmentSamplesSent = 0;
    }
  }

  async close(): Promise<void> {
    if (this.playing) {
      this.playing = false;
      this.onPlaybackFinished({
        playbackPosition: this.sampleRate ? this.segmentSamplesSent / this.sampleRate : 0,
        interrupted: false,
      });
      this.segmentSamplesSent = 0;
    }
  }
}

export class SmartPBXTextOutput extends TextOutput {
  constructor(
    private session: SmartPBXSessionState,
    private onText?: (text: string, session: SmartPBXSessionState) => void,
  ) {
    super();
  }

  override async captureText(text: string | TimedString): Promise<void> {
    const content = isTimedString(text) ? text.text : text;
    if (!content || !this.session.isActive || !this.onText) {
      return;
    }

    this.onText(content, this.session);
  }

  override flush(): void {
    // No-op for SmartPBX text metadata.
  }

  async close(): Promise<void> {
    // No additional cleanup required for SmartPBX text output.
  }
}

/**
 * SmartPBX transport adapter. Extends {@link TransportAdapterBase} for the
 * idempotent-close / listener-registry machinery, but overrides `isOpen`
 * because SmartPBX liveness is a *predicate* (session active && socket
 * open) rather than a pure internal flag. The override ANDs the base's
 * close-tracking with the session/socket predicate: consumers see `false`
 * when the session ends OR when close() has been called.
 *
 * Keep-alive / reconnect policy (C-22.3): none at the transport layer.
 * SmartPBX's native bridge does not manage WebSocket lifecycle — the host
 * process is expected to. When the host detects a closed socket it marks
 * the session inactive; `isOpen` turns false and downstream teardown
 * proceeds. Documented here so the omission is explicit.
 */
export class SmartPBXTransportAdapter extends TransportAdapterBase {
  readonly audioInput: SmartPBXAudioInput;
  readonly audioOutput: SmartPBXAudioOutput;
  readonly textOutput: SmartPBXTextOutput;
  readonly config: {
    sampleRate: number;
    numChannels: 1;
    encoding: 'pcm_s16le';
    samplesPerChannel: null;
  };

  private socket: SmartPBXSocketLike;
  private session: SmartPBXSessionState;
  private websocketOpenState: number;

  constructor(options: SmartPBXTransportAdapterOptions) {
    super(options.session.callId || undefined);

    this.socket = options.socket;
    this.session = options.session;
    this.websocketOpenState = options.websocketOpenState ?? DEFAULT_WEBSOCKET_OPEN_STATE;

    const sampleRate = options.sampleRate ?? DEFAULT_SMARTPBX_SAMPLE_RATE;

    this.audioInput = new SmartPBXAudioInput(this.session, sampleRate);
    this.audioOutput = new SmartPBXAudioOutput(
      this.socket,
      this.session,
      this.websocketOpenState,
      options.onAudioFrame,
      sampleRate,
    );
    this.textOutput = new SmartPBXTextOutput(this.session, options.onText);

    this.config = {
      sampleRate,
      numChannels: 1,
      encoding: 'pcm_s16le',
      samplesPerChannel: null,
    };
  }

  override get isOpen(): boolean {
    return (
      super.isOpen &&
      this.session.isActive &&
      isSocketOpen(this.socket, this.websocketOpenState)
    );
  }
}
