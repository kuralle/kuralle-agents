import { AudioInput, AudioByteStream, type AudioFrame } from '@kuralle-agents/livekit-plugin';
import { TransformStream } from 'node:stream/web';
import type { WebSocket } from 'ws';

/**
 * Receives audio from a WebSocket connection and provides it as a
 * ReadableStream<AudioFrame> to the AgentSession's STT pipeline.
 *
 * Binary WebSocket messages are raw PCM bytes. AudioByteStream accumulates
 * bytes and emits AudioFrame objects at 100ms intervals.
 */
export class WebSocketAudioInput extends AudioInput {
  private byteStream: AudioByteStream;
  private currentStreamId: string | null = null;
  private streamWriter: WritableStreamDefaultWriter<AudioFrame> | null = null;
  private closed: boolean = false;

  constructor(
    private ws: WebSocket,
    sampleRate: number = 24000,
    numChannels: number = 1,
  ) {
    super();
    this.byteStream = new AudioByteStream(sampleRate, numChannels);
    this.setupListeners();
  }

  private setupListeners(): void {
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary || this.closed) return;
      this.handleAudioData(data);
    });

    this.ws.on('close', () => {
      this.endCurrentStream();
    });

    this.ws.on('error', () => {
      this.endCurrentStream();
    });
  }

  private handleAudioData(data: Buffer): void {
    if (!this.currentStreamId) {
      this.startNewStream();
    }

    const frames = this.byteStream.write(
      (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength),
    );

    for (const frame of frames) {
      if (this.streamWriter) {
        this.streamWriter.write(frame).catch((err) => {
          console.error('[WebSocketAudioInput] Error writing frame:', {
            error: err instanceof Error ? err.message : String(err),
            streamId: this.currentStreamId,
            timestamp: new Date().toISOString(),
          });
          this.endCurrentStream();
        });
      }
    }
  }

  private startNewStream(): void {
    const { readable, writable } = new TransformStream<AudioFrame>();
    this.streamWriter = writable.getWriter();
    this.currentStreamId = this.multiStream.addInputStream(readable);
  }

  private endCurrentStream(): void {
    if (this.streamWriter) {
      this.streamWriter.close().catch((err) => {
        console.error('[WebSocketAudioInput] Error closing writer:', {
          error: err instanceof Error ? err.message : String(err),
          streamId: this.currentStreamId,
          timestamp: new Date().toISOString(),
        });
      });
      this.streamWriter = null;
    }
    this.currentStreamId = null;
  }

  /** Called when client sends 'end_of_audio'. Flushes remaining audio. */
  endOfAudio(): void {
    const frames = this.byteStream.flush();
    for (const frame of frames) {
      if (this.streamWriter) {
        this.streamWriter.write(frame).catch((err) => {
          console.error('[WebSocketAudioInput] Error writing flush frame:', {
            error: err instanceof Error ? err.message : String(err),
            streamId: this.currentStreamId,
            timestamp: new Date().toISOString(),
          });
        });
      }
    }
    this.endCurrentStream();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.endCurrentStream();
    await super.close();
  }
}
