import type { RealtimeAudioClient } from '@kuralle-agents/core/realtime';
import type { Runtime } from '@kuralle-agents/core';
import { VoiceCallSession, type RealtimeTransportSession } from '../../VoiceCallSession.js';

export interface CloudflareRealtimeModelPolicy {
  provider?: 'google' | 'openai' | 'azure-openai' | 'xai' | 'phonic' | 'workers-ai' | 'unknown';
  supportsInstructionUpdate?: boolean;
}

export interface CloudflareRealtimeAdapterOptions {
  runtime: Runtime;
  client: RealtimeAudioClient;
  sessionId?: string;
  userId?: string;
  agentId?: string;
  modelPolicy?: CloudflareRealtimeModelPolicy;
  sendJson: (frame: unknown) => void;
  sendBinary: (data: Uint8Array) => void;
  reconnectMaxAttempts?: number;
  reconnectBaseDelayMs?: number;
  reconnectCapDelayMs?: number;
  reconnectAudioBufferBytes?: number;
  initialResumptionHandle?: string;
  onResumptionHandle?: (handle: string, meta: { provider: string; issuedAt: number }) => void;
  onReconnecting?: (reason: string) => void;
  onReconnected?: () => void;
  onEnd?: (reason?: string) => void;
  onError?: (err: Error) => void;
}

export type AdapterState = 'IDLE' | 'CONNECTING' | 'ACTIVE' | 'RECONNECTING' | 'CLOSING' | 'CLOSED';

export class CloudflareRealtimeAdapter {
  #opts: CloudflareRealtimeAdapterOptions;
  #session: VoiceCallSession | null = null;
  #state: AdapterState = 'IDLE';

  constructor(options: CloudflareRealtimeAdapterOptions) {
    this.#opts = options;
  }

  get state(): AdapterState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state !== 'IDLE') {
      throw new Error(`CloudflareRealtimeAdapter: start() while state=${this.#state}`);
    }
    this.#state = 'CONNECTING';
    const sessionId = this.#opts.sessionId ?? crypto.randomUUID();
    const transport: RealtimeTransportSession = {
      sendAudio: (data) => this.#opts.sendBinary(data),
      onAudio: (handler) => {
        this.#onUserAudio = handler;
      },
      onClose: (handler) => {
        this.#onTransportClose = handler;
      },
      close: () => {
        this.#state = 'CLOSED';
      },
      clearAudioBuffer: () => {},
    };

    this.#session = new VoiceCallSession({
      runtime: this.#opts.runtime,
      modelClient: this.#opts.client,
      transport,
      sessionId,
      userId: this.#opts.userId,
      agentId: this.#opts.agentId,
    });

    try {
      await this.#session.start();
      this.#state = 'ACTIVE';
    } catch (err) {
      this.#state = 'IDLE';
      const e = err instanceof Error ? err : new Error(String(err));
      await this.#opts.onError?.(e);
      throw e;
    }
  }

  #onUserAudio: ((data: Uint8Array) => void) | null = null;
  #onTransportClose: (() => void) | null = null;

  sendUserAudio(frame: Uint8Array): void {
    this.#onUserAudio?.(frame);
  }

  sendUserText(text: string): void {
    const c = this.#opts.client as { pushText?: (t: string) => void; requestResponse?: (t?: string) => void };
    c.pushText?.(text);
    c.requestResponse?.(text);
  }

  sendInterrupt(): void {
    const c = this.#opts.client as { sendInterrupt?: () => void };
    c.sendInterrupt?.();
  }

  async stop(reason?: string): Promise<void> {
    if (this.#state === 'CLOSING' || this.#state === 'CLOSED') return;
    this.#state = 'CLOSING';
    await this.#session?.stop();
    this.#session = null;
    this.#state = 'CLOSED';
    this.#opts.onEnd?.(reason);
  }
}
