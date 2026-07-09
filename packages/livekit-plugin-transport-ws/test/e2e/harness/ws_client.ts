/**
 * Programmatic WebSocket client for e2e testing.
 *
 * Implements the WS transport protocol (configure, user_text, end_of_audio,
 * binary audio frames) and provides helpers for message collection and
 * timing measurement.
 */

import { WebSocket } from 'ws';
import { TraceCollector } from './trace_collector.js';

export interface WsClientOptions {
  url: string;
  trace: TraceCollector;
  connectTimeoutMs?: number;
}

export class WsTestClient {
  readonly ws: WebSocket;
  readonly trace: TraceCollector;
  private messageQueue: Array<{ data: unknown; isBinary: boolean }> = [];
  private waiters: Array<{
    resolve: (msg: { data: unknown; isBinary: boolean }) => void;
    filter?: (msg: { data: unknown; isBinary: boolean }) => boolean;
  }> = [];
  private _closed = false;
  private _closeCode: number | null = null;
  private _closeReason: string | null = null;

  constructor(options: WsClientOptions) {
    this.trace = options.trace;
    this.ws = new WebSocket(options.url);

    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      const msg = { data, isBinary };

      if (isBinary) {
        this.trace.recordBinaryChunk(data.byteLength);
      } else {
        try {
          const parsed = JSON.parse(data.toString());
          this.trace.recordJsonMessage(parsed);
        } catch {
          this.trace.record('ws:unparseable', { preview: data.toString().slice(0, 100) });
        }
      }

      // Check waiters first
      for (let i = 0; i < this.waiters.length; i++) {
        const waiter = this.waiters[i];
        if (!waiter.filter || waiter.filter(msg)) {
          this.waiters.splice(i, 1);
          waiter.resolve(msg);
          return;
        }
      }

      this.messageQueue.push(msg);
    });

    this.ws.on('close', (code, reason) => {
      this._closed = true;
      this._closeCode = code;
      this._closeReason = reason.toString();
      this.trace.record('ws:close', { code, reason: this._closeReason });
    });

    this.ws.on('error', (err) => {
      this.trace.record('ws:error', { message: err.message });
    });
  }

  // ─── Connection ────────────────────────────────────────────────────────

  async waitForOpen(timeoutMs = 5000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS open timeout')), timeoutMs);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async waitForClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    if (this._closed) {
      return { code: this._closeCode!, reason: this._closeReason! };
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
      this.ws.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  get isClosed(): boolean {
    return this._closed;
  }

  // ─── Sending ───────────────────────────────────────────────────────────

  sendConfigure(config: {
    sampleRate?: number;
    numChannels?: number;
    encoding?: string;
  }): void {
    this.ws.send(JSON.stringify({ type: 'configure', ...config }));
  }

  sendUserText(text: string): void {
    this.ws.send(JSON.stringify({ type: 'user_text', text }));
    this.trace.record('client:user_text', { text: text.slice(0, 80) });
  }

  sendEndOfAudio(): void {
    this.ws.send(JSON.stringify({ type: 'end_of_audio' }));
    this.trace.record('client:end_of_audio');
  }

  sendAudioFrames(pcmData: Uint8Array, frameSize = 1920): void {
    let offset = 0;
    let frameCount = 0;
    while (offset + frameSize <= pcmData.length) {
      const frame = pcmData.slice(offset, offset + frameSize);
      this.ws.send(frame);
      offset += frameSize;
      frameCount++;
    }
    if (offset < pcmData.length) {
      this.ws.send(pcmData.slice(offset));
      frameCount++;
    }
    this.trace.record('client:audio_sent', { bytes: pcmData.length, frames: frameCount });
  }

  /**
   * Send audio frames paced at real-time speed.
   * Each frame of `frameSize` bytes represents `frameDurationMs` of audio.
   * For 24kHz int16 mono PCM: frameSize=960 → 20ms, frameSize=1920 → 40ms.
   */
  async sendAudioFramesPaced(
    pcmData: Uint8Array,
    frameSize = 960,
    frameDurationMs = 20,
  ): Promise<void> {
    let offset = 0;
    let frameCount = 0;
    while (offset + frameSize <= pcmData.length) {
      const frame = pcmData.slice(offset, offset + frameSize);
      this.ws.send(frame);
      offset += frameSize;
      frameCount++;
      await sleep(frameDurationMs);
    }
    if (offset < pcmData.length) {
      this.ws.send(pcmData.slice(offset));
      frameCount++;
    }
    this.trace.record('client:audio_sent_paced', { bytes: pcmData.length, frames: frameCount, frameDurationMs });
  }

  // ─── Receiving ─────────────────────────────────────────────────────────

  /**
   * Wait for the next JSON message of a specific type.
   */
  async waitForJsonMessage(
    type: string,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    // Check queue first
    for (let i = 0; i < this.messageQueue.length; i++) {
      const msg = this.messageQueue[i];
      if (!msg.isBinary) {
        try {
          const parsed = JSON.parse(Buffer.isBuffer(msg.data) ? msg.data.toString() : String(msg.data));
          if (parsed.type === type) {
            this.messageQueue.splice(i, 1);
            return parsed;
          }
        } catch { /* skip */ }
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for message type '${type}'`)),
        timeoutMs,
      );

      this.waiters.push({
        resolve: (msg) => {
          clearTimeout(timer);
          const parsed = JSON.parse(Buffer.isBuffer(msg.data) ? msg.data.toString() : String(msg.data));
          resolve(parsed);
        },
        filter: (msg) => {
          if (msg.isBinary) return false;
          try {
            const parsed = JSON.parse(Buffer.isBuffer(msg.data) ? msg.data.toString() : String(msg.data));
            return parsed.type === type;
          } catch {
            return false;
          }
        },
      });
    });
  }

  /**
   * Collect all messages (JSON and binary) for a duration.
   */
  async collectFor(durationMs: number): Promise<{
    json: Array<Record<string, unknown>>;
    binaryCount: number;
    binaryBytes: number;
  }> {
    const startBinaryCount = this.trace.binaryChunks.length;
    const startBinaryBytes = this.trace.totalBinaryBytes;
    const startJsonCount = this.trace.jsonMessages.length;

    await sleep(durationMs);

    const newJson = this.trace.jsonMessages
      .slice(startJsonCount)
      .map((m) => m.data);
    const newBinaryCount = this.trace.binaryChunks.length - startBinaryCount;
    const newBinaryBytes = this.trace.totalBinaryBytes - startBinaryBytes;

    return { json: newJson, binaryCount: newBinaryCount, binaryBytes: newBinaryBytes };
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────

  close(): void {
    if (!this._closed && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000);
    }
  }

  terminate(): void {
    this.ws.terminate();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
