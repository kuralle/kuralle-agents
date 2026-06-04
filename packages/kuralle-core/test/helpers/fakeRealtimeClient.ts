import type {
  RealtimeAudioClient,
  RealtimeCapabilities,
  RealtimeEventMap,
  RealtimeSessionConfig,
  RealtimeToolResponse,
} from '../../src/realtime/RealtimeAudioClient.js';

export interface CannedResponse {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface FakeRealtimeAudioClientConfig {
  responses: Record<string, CannedResponse>;
  defaultResponse?: CannedResponse;
  responseDelayMs?: number;
}

const DEFAULT_CAPS: RealtimeCapabilities = {
  turnDetection: true,
  userTranscription: true,
  messageTruncation: true,
  autoToolReplyGeneration: false,
  audioOutput: true,
  manualFunctionCalls: true,
  midSessionInstructionsUpdate: true,
  midSessionToolsUpdate: true,
};

export class FakeRealtimeAudioClient implements RealtimeAudioClient {
  readonly capabilities = DEFAULT_CAPS;
  readonly provider = 'fake';
  readonly model = 'fake-realtime';

  private _connected = false;
  private _config: RealtimeSessionConfig | null = null;
  private handlers = new Map<keyof RealtimeEventMap, Set<(...args: unknown[]) => void>>();
  private readonly cfg: FakeRealtimeAudioClientConfig;
  private pendingAfterTools: CannedResponse | null = null;
  private pendingToolResponses = 0;
  private callSeq = 0;
  lastUserText = '';
  stallResponse = false;

  /** When stallResponse is true, emit a tool-call sequence manually (test API). */
  emitToolCallTurn(toolName: string, args: Record<string, unknown> = {}): void {
    this.pendingAfterTools = { text: 'Done.' };
    this.pendingToolResponses = 1;
    this.emit('tool-call', this.nextFakeId(), toolName, args);
  }
  private requestResponseCount = 0;

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

  get inferenceCallCount(): number {
    return this.requestResponseCount;
  }

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this._config = config;
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.emit('disconnected');
  }

  sendAudio(_frame: Uint8Array): void {}

  sendToolResponse(responses: RealtimeToolResponse[]): void {
    this.receivedToolResponses.push(...responses);
    if (this.pendingToolResponses <= 0) {
      return;
    }
    const n = Math.max(1, responses.length);
    this.pendingToolResponses -= n;
    if (this.pendingToolResponses <= 0) {
      this.pendingToolResponses = 0;
      const pending = this.pendingAfterTools;
      this.pendingAfterTools = null;
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
    this.requestResponseCount += 1;
    if (this.stallResponse) {
      return;
    }
    this.schedule(() => {
      const response = this.matchResponse(this.lastUserText);
      this.emitAssistantResponse(response);
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

  injectUserUtterance(text: string): void {
    this.lastUserText = text;
    this.schedule(() => {
      this.emit('transcript', text, 'user');
      this.emit('turn-complete');
    });
  }

  injectBargeIn(userText: string, partialAssistantText: string): void {
    this.lastUserText = userText;
    this.schedule(() => {
      if (partialAssistantText.length > 0) {
        this.emit('transcript', partialAssistantText, 'assistant');
      }
      this.emit('interrupted');
      this.emit('transcript', userText, 'user');
      this.emit('turn-complete');
    });
  }

  /** Emit multiple assistant transcript chunks then turn-complete (stallResponse must be true). */
  emitAssistantChunks(chunks: string[]): void {
    this.schedule(() => {
      for (const chunk of chunks) {
        if (chunk.length > 0) {
          this.emit('transcript', chunk, 'assistant');
        }
      }
      this.emit('turn-complete');
    });
  }

  /** End a stalled turn with no assistant transcript (stallResponse must be true). */
  emitTurnCompleteOnly(): void {
    this.schedule(() => {
      this.emit('turn-complete');
    });
  }

  private emitAssistantResponse(response: CannedResponse): void {
    if (response.toolCalls?.length) {
      this.pendingAfterTools = response;
      this.pendingToolResponses = response.toolCalls.length;
      for (const tc of response.toolCalls) {
        this.emit('tool-call', this.nextFakeId(), tc.name, tc.args);
      }
      return;
    }
    const t = response.text ?? '';
    if (t.length > 0) {
      this.emit('transcript', t, 'assistant');
    }
    this.emit('turn-complete');
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

  private matchResponse(text: string): CannedResponse {
    const instruction = this._config?.systemInstruction ?? '';
    if (instruction.toLowerCase().includes('premium')) {
      return { text: 'Premium confirmed.' };
    }

    const lower = text.toLowerCase();
    for (const [pattern, response] of Object.entries(this.cfg.responses)) {
      if (lower.includes(pattern.toLowerCase())) return response;
    }
    return this.cfg.defaultResponse ?? { text: "I don't understand." };
  }
}

export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}
