/**
 * Deterministic fake {@link RealtimeAudioClient} for voice pipeline tests.
 * Text-injection only — no audio, no external APIs.
 */

import type {
  RealtimeAudioClient,
  RealtimeEventMap,
  RealtimeSessionConfig,
  RealtimeToolResponse,
} from '@kuralle-agents/core/realtime';

export interface CannedResponse {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface FakeRealtimeAudioClientConfig {
  responses: Record<string, CannedResponse>;
  defaultResponse?: CannedResponse;
  /** Delay before emitting each injected response segment (default 0). */
  responseDelayMs?: number;
}

export class FakeRealtimeAudioClient implements RealtimeAudioClient {
  readonly capabilities = {
    turnDetection: false,
    userTranscription: true,
    messageTruncation: false,
    autoToolReplyGeneration: true,
    audioOutput: false,
    manualFunctionCalls: true,
  };
  readonly provider = 'fake';
  readonly model = 'fake';

  private _connected = false;
  private _config: RealtimeSessionConfig | null = null;
  private handlers = new Map<keyof RealtimeEventMap, Set<(...args: unknown[]) => void>>();
  private readonly cfg: FakeRealtimeAudioClientConfig;
  private pendingAfterTools: CannedResponse | null = null;
  private pendingToolResponses = 0;
  private callSeq = 0;

  readonly receivedToolResponses: RealtimeToolResponse[] = [];
  readonly configHistory: Array<Partial<RealtimeSessionConfig>> = [];

  constructor(config: FakeRealtimeAudioClientConfig) {
    this.cfg = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  get receivedConfig(): RealtimeSessionConfig | null {
    return this._config;
  }

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this._config = config;
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.emit('disconnected');
  }

  sendAudio(_frame: Uint8Array): void {
    /* no-op */
  }

  sendToolResponse(responses: RealtimeToolResponse[]): void {
    this.receivedToolResponses.push(...responses);
    if (this.pendingToolResponses <= 0) {
      return;
    }
    // One runtime invocation per tool call; each sends a single-element batch.
    const n = Math.max(1, responses.length);
    this.pendingToolResponses -= n;
    if (this.pendingToolResponses <= 0) {
      this.pendingToolResponses = 0;
      const pending = this.pendingAfterTools;
      this.pendingAfterTools = null;
      // Defer so listeners can register before turn-complete fires
      // (matches wire-delayed turn-complete from real providers).
      queueMicrotask(() => {
        if (pending?.text) {
          this.emit('transcript', pending.text, 'assistant');
        }
        this.emit('turn-complete');
      });
    }
  }

  async updateConfig(config: Partial<RealtimeSessionConfig>): Promise<void> {
    if (!this._config) {
      this._config = {
        systemInstruction: config.systemInstruction ?? '',
        tools: config.tools ?? [],
        ...config,
      } as RealtimeSessionConfig;
    } else {
      this._config = { ...this._config, ...config };
    }
    this.configHistory.push(config);
  }

  requestResponse(_instruction?: string): void {
    this.schedule(() => {
      queueMicrotask(() => {
        this.emit('transcript', 'Continuing.', 'assistant');
        this.emit('turn-complete');
      });
    });
  }

  async ping(): Promise<boolean> {
    return this._connected;
  }

  on<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as (...args: unknown[]) => void);
  }

  off<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    this.handlers.get(event)?.delete(handler as (...args: unknown[]) => void);
  }

  private emit<K extends keyof RealtimeEventMap>(event: K, ...args: Parameters<RealtimeEventMap[K]>): void {
    for (const h of this.handlers.get(event) ?? []) {
      (h as (...a: unknown[]) => void)(...(args as unknown[]));
    }
  }

  private schedule(fn: () => void): void {
    const ms = this.cfg.responseDelayMs ?? 0;
    if (ms <= 0) fn();
    else setTimeout(fn, ms);
  }

  private nextFakeId(): string {
    this.callSeq += 1;
    return `fake-${this.callSeq}`;
  }

  /** Drive a user turn (test API). */
  injectUserInput(text: string): void {
    this.pendingAfterTools = null;
    this.pendingToolResponses = 0;

    const run = () => {
      this.emit('transcript', text, 'user');
      const response = this.matchResponse(text);
      if (response.toolCalls?.length) {
        this.pendingAfterTools = response;
        this.pendingToolResponses = response.toolCalls.length;
        for (const tc of response.toolCalls) {
          this.emit('tool-call', this.nextFakeId(), tc.name, tc.args);
        }
      } else {
        const t = response.text ?? '';
        if (t.length > 0) {
          this.emit('transcript', t, 'assistant');
        }
        this.emit('turn-complete');
      }
    };

    this.schedule(run);
  }

  private matchResponse(text: string): CannedResponse {
    const lower = text.toLowerCase();
    for (const [pattern, response] of Object.entries(this.cfg.responses)) {
      if (lower.includes(pattern.toLowerCase())) return response;
    }
    return this.cfg.defaultResponse ?? { text: "I don't understand." };
  }
}
