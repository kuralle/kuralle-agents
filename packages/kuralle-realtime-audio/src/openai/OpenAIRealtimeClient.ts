/**
 * OpenAIRealtimeClient — implements RealtimeAudioClient for OpenAI Realtime API.
 *
 * Key features:
 * - WebSocket connection via `ws` package
 * - Native G.711 μ-law (audio/pcmu) support — zero resampling for SIP/telephony
 * - PCM16 support for non-telephony use
 * - Session lifecycle: connect → session.created → session.update → session.updated
 * - Tool calling: function_call_arguments.done → tool-call event → sendToolResponse
 *
 * Ported from research/sip-to-ai/app/ai/openai_realtime.py
 */

import WebSocket from 'ws';
import type {
  RealtimeAudioClient,
  RealtimeCapabilities,
  RealtimeSessionConfig,
  RealtimeToolResponse,
  RealtimeEventMap,
} from '@kuralle-agents/core/realtime';
import {
  OPENAI_REALTIME_CAPABILITIES,
  buildSessionUpdate,
} from './protocol.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface OpenAIRealtimeClientConfig {
  apiKey: string;
  /** OpenAI Realtime model. Default: 'gpt-realtime' */
  model?: string;
}

// ─── OpenAI message types (internal) ─────────────────────────────────────────

interface OpenAIMessage {
  type: string;
  [key: string]: unknown;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class OpenAIRealtimeClient implements RealtimeAudioClient {
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private ws: WebSocket | null = null;
  private _connected = false;
  private sessionConfig: RealtimeSessionConfig | null = null;

  // Typed event listener registry
  private listeners: Map<keyof RealtimeEventMap, Set<(...args: unknown[]) => void>> = new Map();

  // Promise resolvers for session lifecycle
  private sessionCreatedResolve: (() => void) | null = null;
  private sessionUpdatedResolve: (() => void) | null = null;

  // ─── RealtimeAudioClient v2 — capabilities / provider / model ──────────────

  readonly capabilities: RealtimeCapabilities = OPENAI_REALTIME_CAPABILITIES;
  readonly provider: string = 'openai';
  readonly model: string;

  constructor(config: OpenAIRealtimeClientConfig) {
    this.apiKey = config.apiKey;
    this.defaultModel = config.model ?? 'gpt-realtime';
    this.model = this.defaultModel;
  }

  // ─── RealtimeAudioClient: connected ────────────────────────────────────────

  get connected(): boolean {
    return this._connected;
  }

  // ─── RealtimeAudioClient: on / off ─────────────────────────────────────────

  on<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as (...args: unknown[]) => void);
  }

  off<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    this.listeners.get(event)?.delete(handler as (...args: unknown[]) => void);
  }

  private emit<K extends keyof RealtimeEventMap>(
    event: K,
    ...args: Parameters<RealtimeEventMap[K]>
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(...(args as unknown[]));
    }
  }

  // ─── RealtimeAudioClient: connect ──────────────────────────────────────────

  async connect(config: RealtimeSessionConfig): Promise<void> {
    if (this._connected) return;

    this.sessionConfig = config;
    const model = config.model ?? this.defaultModel;

    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    this.ws = ws;

    // Register all handlers before waiting for open so no messages are missed.
    ws.on('message', (data: Buffer) => {
      try {
        this.handleMessage(JSON.parse(data.toString()) as OpenAIMessage);
      } catch (err) {
        console.error('[OpenAIRealtimeClient] Message parse error:', err);
      }
    });

    ws.on('close', () => {
      this._connected = false;
      this.emit('disconnected');
    });

    ws.on('error', (err: Error) => {
      console.error('[OpenAIRealtimeClient] WebSocket error:', err);
      this.emit('error', err.message);
    });

    // Wait for the WebSocket to open.
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (err: Error) => { cleanup(); reject(err); };
      const cleanup = () => { ws.off('open', onOpen); ws.off('error', onError); };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    // Wait for session.created from OpenAI (signals model is ready to configure).
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('[OpenAIRealtimeClient] Timeout waiting for session.created')),
        10_000,
      );
      this.sessionCreatedResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });

    // Send session.update with our config.
    this.sendRaw(buildSessionUpdate(config, { defaultModel: this.defaultModel }));

    // Wait for session.updated to confirm the config was applied.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('[OpenAIRealtimeClient] Timeout waiting for session.updated')),
        10_000,
      );
      this.sessionUpdatedResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });

    this._connected = true;
  }

  // ─── RealtimeAudioClient: disconnect ───────────────────────────────────────

  async disconnect(): Promise<void> {
    if (!this._connected && !this.ws) return;

    this._connected = false;
    this.sessionCreatedResolve = null;
    this.sessionUpdatedResolve = null;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  // ─── RealtimeAudioClient: sendAudio ────────────────────────────────────────

  sendAudio(frame: Uint8Array): void {
    if (!this._connected || !this.ws) return;

    const base64 = Buffer.from(frame).toString('base64');
    this.sendRaw({ type: 'input_audio_buffer.append', audio: base64 });
  }

  // ─── RealtimeAudioClient: sendToolResponse ─────────────────────────────────

  sendToolResponse(responses: RealtimeToolResponse[]): void {
    if (!this._connected || !this.ws) return;

    // Create a conversation item for each tool result.
    for (const response of responses) {
      this.sendRaw({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: response.id,
          output: JSON.stringify(response.output),
        },
      });
    }

    // Trigger model response continuation.
    this.sendRaw({ type: 'response.create' });
  }

  // ─── RealtimeAudioClient: updateConfig ─────────────────────────────────────

  async updateConfig(config: Partial<RealtimeSessionConfig>): Promise<void> {
    if (!this._connected || !this.ws) return;

    // Merge with existing session config.
    this.sessionConfig = { ...this.sessionConfig!, ...config };

    this.sendRaw(buildSessionUpdate(this.sessionConfig, { defaultModel: this.defaultModel }));

    // Wait for the updated acknowledgement.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('[OpenAIRealtimeClient] Timeout waiting for session.updated')),
        10_000,
      );
      this.sessionUpdatedResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  // ─── RealtimeAudioClient: ping ─────────────────────────────────────────────

  async ping(): Promise<boolean> {
    if (!this._connected || !this.ws) return false;

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5_000);
      this.ws!.once('pong', () => {
        clearTimeout(timeout);
        resolve(true);
      });
      this.ws!.ping();
    });
  }

  // ─── Private: message handling ─────────────────────────────────────────────

  private handleMessage(data: OpenAIMessage): void {
    const type = data.type;

    switch (type) {
      case 'session.created':
        this.sessionCreatedResolve?.();
        this.sessionCreatedResolve = null;
        break;

      case 'session.updated':
        this.sessionUpdatedResolve?.();
        this.sessionUpdatedResolve = null;
        break;

      case 'response.output_audio.delta': {
        // Audio chunk: base64-encoded G.711 μ-law or PCM16 from OpenAI.
        const audioBase64 = data.delta as string | undefined;
        if (audioBase64) {
          const audioBytes = new Uint8Array(Buffer.from(audioBase64, 'base64'));
          this.emit('audio', audioBytes);
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        // Final user speech transcription.
        const transcript = data.transcript as string | undefined;
        if (transcript) {
          this.emit('transcript', transcript, 'user');
        }
        break;
      }

      case 'response.audio_transcript.done': {
        // Final assistant speech transcription.
        const transcript = data.transcript as string | undefined;
        if (transcript) {
          this.emit('transcript', transcript, 'assistant');
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        // Tool call from the model.
        const callId = data.call_id as string;
        const name = data.name as string;
        const rawArgs = data.arguments as string;
        let args: unknown = {};
        try {
          args = rawArgs ? JSON.parse(rawArgs) : {};
        } catch {
          args = rawArgs;
        }
        this.emit('tool-call', callId, name, args);
        break;
      }

      case 'response.done': {
        // Model finished its response turn.
        this.emit('turn-complete');
        break;
      }

      case 'input_audio_buffer.speech_started': {
        // User barge-in detected.
        this.emit('interrupted');
        break;
      }

      case 'error': {
        const errObj = data.error as { message?: string } | undefined;
        const message = errObj?.message ?? String(data.error ?? 'Unknown OpenAI error');
        console.error('[OpenAIRealtimeClient] API error:', message);
        this.emit('error', message);
        break;
      }

      default:
        // Silently ignore unhandled event types (e.g. rate_limits, response.created, etc.)
        break;
    }
  }

  // ─── Private: helpers ──────────────────────────────────────────────────────

  private sendRaw(message: Record<string, unknown>): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      console.error('[OpenAIRealtimeClient] Send error:', err);
    }
  }

}
