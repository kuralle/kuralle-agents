import { AudioInput, AudioByteStream, type AudioFrame } from '@kuralle-agents/livekit-plugin';
import { TransformStream } from 'node:stream/web';

/**
 * Receives audio from HTTP POST requests and provides it as a
 * ReadableStream<AudioFrame> to the AgentSession's STT pipeline.
 *
 * Audio can arrive as a complete blob (base64 in JSON POST) for
 * push-to-talk, or as chunked streaming for lower latency.
 */
export class HTTPAudioInput extends AudioInput {
  private byteStream: AudioByteStream;
  private currentWriter: WritableStreamDefaultWriter<AudioFrame> | null = null;
  private currentStreamId: string | null = null;

  constructor(
    sampleRate: number = 24000,
    numChannels: number = 1,
  ) {
    super();
    this.byteStream = new AudioByteStream(sampleRate, numChannels);
  }

  /**
   * Push a complete audio buffer from a POST request body.
   * Creates a new input stream, writes all frames, and closes it.
   */
  pushAudioBuffer(
    pcmData: ArrayBuffer,
    sampleRate: number,
    numChannels: number,
  ): void {
    const localByteStream = new AudioByteStream(sampleRate, numChannels);
    const frames = localByteStream.write(pcmData);
    frames.push(...localByteStream.flush());

    if (frames.length === 0) return;

    const { readable, writable } = new TransformStream<AudioFrame>();
    const writer = writable.getWriter();
    this.multiStream.addInputStream(readable);

    (async () => {
      for (const frame of frames) {
        await writer.write(frame);
      }
      await writer.close();
    })();
  }

  /**
   * Start a streaming audio input for chunked transfer encoding.
   */
  startStreamingInput(): {
    write: (chunk: ArrayBuffer) => void;
    end: () => void;
  } {
    const { readable, writable } = new TransformStream<AudioFrame>();
    this.currentWriter = writable.getWriter();
    this.currentStreamId = this.multiStream.addInputStream(readable);

    return {
      write: (chunk: ArrayBuffer) => {
        const frames = this.byteStream.write(chunk);
        for (const frame of frames) {
          this.currentWriter?.write(frame).catch((err) => {
            // Stream may be closed if client disconnected - this is expected
            if (this.currentWriter) {
              console.error('[HTTPAudioInput] Error writing frame:', {
                error: err instanceof Error ? err.message : String(err),
                streamId: this.currentStreamId,
                timestamp: new Date().toISOString(),
              });
            }
          });
        }
      },
      end: () => {
        const frames = this.byteStream.flush();
        for (const frame of frames) {
          this.currentWriter?.write(frame).catch((err) => {
            // Stream may be closed - this is expected
            if (this.currentWriter) {
              console.error('[HTTPAudioInput] Error writing flush frame:', {
                error: err instanceof Error ? err.message : String(err),
                streamId: this.currentStreamId,
                timestamp: new Date().toISOString(),
              });
            }
          });
        }
        this.currentWriter?.close().catch((err) => {
          // Stream may already be closed - this is expected
          if (this.currentWriter) {
            console.error('[HTTPAudioInput] Error closing writer:', {
              error: err instanceof Error ? err.message : String(err),
              streamId: this.currentStreamId,
              timestamp: new Date().toISOString(),
            });
          }
        });
        this.currentWriter = null;
        this.currentStreamId = null;
      },
    };
  }

  async close(): Promise<void> {
    if (this.currentWriter) {
      await this.currentWriter.close().catch((err) => {
        console.error('[HTTPAudioInput] Error closing during cleanup:', {
          error: err instanceof Error ? err.message : String(err),
          streamId: this.currentStreamId,
          timestamp: new Date().toISOString(),
        });
      });
    }
    await super.close();
  }
}
