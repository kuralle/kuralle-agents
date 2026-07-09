/**
 * Test-only stubs for unit-testing the realtime voice mixin without a real
 * Durable Object, WebSocket, or live provider. Kept here (not in src/voice/
 * proper) so the dist is lean.
 */

import type {
  RealtimeAudioClient,
  RealtimeCapabilities,
  RealtimeEventMap,
  RealtimeSessionConfig,
  RealtimeToolResponse,
} from "@kuralle-agents/core/realtime";

type Frame = { type: "json"; value: unknown } | { type: "binary"; bytes: Uint8Array };

/** Minimal fake `Connection` matching the shape the mixin uses. */
export class FakeConnection {
  readonly frames: Frame[] = [];
  #open = true;
  constructor(public readonly id: string) {}
  send(data: string | ArrayBuffer | Uint8Array): void {
    if (!this.#open) return;
    if (typeof data === "string") {
      try {
        this.frames.push({ type: "json", value: JSON.parse(data) });
      } catch {
        this.frames.push({ type: "json", value: data });
      }
      return;
    }
    const bytes =
      data instanceof Uint8Array
        ? new Uint8Array(data)
        : new Uint8Array(data as ArrayBuffer);
    this.frames.push({ type: "binary", bytes });
  }
  close(): void {
    this.#open = false;
  }
  /** Helper: all JSON frames pushed to this connection. */
  jsonFrames(): Array<Record<string, unknown>> {
    return this.frames
      .filter((f): f is { type: "json"; value: unknown } => f.type === "json")
      .map((f) => f.value as Record<string, unknown>);
  }
  binaryFrames(): Uint8Array[] {
    return this.frames
      .filter((f): f is { type: "binary"; bytes: Uint8Array } => f.type === "binary")
      .map((f) => f.bytes);
  }
}

const STUB_CAPABILITIES: RealtimeCapabilities = {
  turnDetection: true,
  userTranscription: true,
  messageTruncation: false,
  autoToolReplyGeneration: true,
  audioOutput: true,
  manualFunctionCalls: true,
  midSessionChatCtxUpdate: false,
  midSessionInstructionsUpdate: false,
  midSessionToolsUpdate: false,
  // The existing suite exercises the Gemini-style `handle` reconnect strategy.
  // A sibling suite (`replay`-strategy) uses a different stub.
  reconnectStrategy: 'handle',
};

/**
 * Scriptable `RealtimeAudioClient` for tests. Records every call, lets tests
 * fire canned events, and round-trips tool responses back into the recorder.
 */
export class StubRealtimeClient implements RealtimeAudioClient {
  readonly capabilities: RealtimeCapabilities = STUB_CAPABILITIES;
  readonly provider: string = "stub";
  readonly model: string = "stub-model-v1";

  connectCalls: RealtimeSessionConfig[] = [];
  disconnectCount = 0;
  audioSent: Uint8Array[] = [];
  toolResponses: RealtimeToolResponse[][] = [];
  textPushed: string[] = [];
  requestResponseCalls: string[] = [];
  interruptCount = 0;
  connected = false;
  /** Push an Error here to make the next connect() call reject (pop-front). */
  connectErrors: Error[] = [];

  #listeners: Partial<{ [K in keyof RealtimeEventMap]: Set<RealtimeEventMap[K]> }> = {};
  #extraListeners = new Map<string, Set<(...args: unknown[]) => void>>();

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.connectCalls.push(config);
    const err = this.connectErrors.shift();
    if (err) throw err;
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.connected = false;
    this.emit("disconnected");
  }
  sendAudio(frame: Uint8Array): void {
    this.audioSent.push(new Uint8Array(frame));
  }
  sendToolResponse(responses: RealtimeToolResponse[]): void {
    this.toolResponses.push(responses);
  }
  pushText(text: string): void {
    this.textPushed.push(text);
  }
  requestResponse(text?: string): void {
    this.requestResponseCalls.push(text ?? '');
  }
  sendInterrupt(): void {
    this.interruptCount += 1;
  }
  async updateConfig(_config: Partial<RealtimeSessionConfig>): Promise<void> {}
  async ping(): Promise<boolean> {
    return this.connected;
  }
  on<K extends keyof RealtimeEventMap>(event: K | string, handler: RealtimeEventMap[K] | ((...args: unknown[]) => void)): void {
    if (event in mkTypedEvents) {
      const set = (this.#listeners[event as keyof RealtimeEventMap] ??= new Set()) as Set<RealtimeEventMap[K]>;
      set.add(handler as RealtimeEventMap[K]);
    } else {
      let set = this.#extraListeners.get(event as string);
      if (!set) {
        set = new Set();
        this.#extraListeners.set(event as string, set);
      }
      set.add(handler as (...args: unknown[]) => void);
    }
  }
  off<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    this.#listeners[event]?.delete(handler as never);
  }

  /** Fire a typed core event to every registered listener. */
  emit<K extends keyof RealtimeEventMap>(event: K, ...args: Parameters<RealtimeEventMap[K]>): void {
    const set = this.#listeners[event];
    if (!set) return;
    for (const h of set) (h as (...a: unknown[]) => void)(...args);
  }

  /** Fire a provider-extension event (sessionResumptionUpdate, goAway). */
  emitExtra(event: string, payload: unknown): void {
    const set = this.#extraListeners.get(event);
    if (!set) return;
    for (const h of set) h(payload);
  }
}

/**
 * Replay-strategy stub modeling an OpenAI-family client. Tracks an internal
 * chat_ctx mirror, supports snapshot/replay, declares
 * `reconnectStrategy: 'replay'` so `withRealtimeVoice` routes through
 * `#reconnectWithReplay`.
 */
const REPLAY_STUB_CAPABILITIES: RealtimeCapabilities = {
  turnDetection: true,
  userTranscription: true,
  messageTruncation: true,
  autoToolReplyGeneration: false,
  audioOutput: true,
  manualFunctionCalls: true,
  midSessionChatCtxUpdate: true,
  midSessionInstructionsUpdate: true,
  midSessionToolsUpdate: true,
  reconnectStrategy: 'replay',
};

interface ReplayChatCtxItem {
  itemId: string;
  role: string;
  kind: string;
  content: unknown[];
  position: number;
}

// Sentinel used to distinguish typed core events vs. provider extensions.
const mkTypedEvents: Record<keyof RealtimeEventMap, true> = {
  audio: true,
  transcript: true,
  "tool-call": true,
  "turn-complete": true,
  interrupted: true,
  error: true,
  disconnected: true,
};
