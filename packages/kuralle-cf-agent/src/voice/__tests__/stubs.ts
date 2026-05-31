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

/** Fake in-memory SQL executor backing the `cf_realtime_resumption` table. */
export function createFakeSql() {
  type Row = {
    connection_id: string;
    provider: string;
    handle: string;
    updated_at: number;
    used_at: number | null;
  };
  type ChatCtxRow = {
    connection_id: string;
    position: number;
    item_id: string;
    role: string;
    kind: string;
    content: string;
    updated_at: number;
  };
  const rows = new Map<string, Row>();
  const chatCtx = new Map<string, ChatCtxRow[]>();
  let schemaCreated = false;
  const sql = function <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): T[] | undefined {
    const q = strings.join("?").trim().replace(/\s+/g, " ").toUpperCase();
    if (q.startsWith("CREATE TABLE")) {
      schemaCreated = true;
      return undefined;
    }
    if (q.startsWith("ALTER TABLE")) {
      return undefined;
    }
    if (!schemaCreated) throw new Error("schema not created");
    if (q.startsWith("SELECT HANDLE, UPDATED_AT, USED_AT FROM CF_REALTIME_RESUMPTION WHERE CONNECTION_ID")) {
      const cid = values[0] as string;
      const row = rows.get(cid);
      return (row
        ? [{ handle: row.handle, updated_at: row.updated_at, used_at: row.used_at }]
        : []) as T[];
    }
    if (q.startsWith("INSERT INTO CF_REALTIME_RESUMPTION")) {
      const [connection_id, provider, handle, updated_at] = values as [string, string, string, number];
      rows.set(connection_id, { connection_id, provider, handle, updated_at, used_at: null });
      return undefined;
    }
    if (q.startsWith("UPDATE CF_REALTIME_RESUMPTION SET USED_AT")) {
      const [used_at, cid] = values as [number, string];
      const row = rows.get(cid);
      if (row) row.used_at = used_at;
      return undefined;
    }
    if (q.startsWith("DELETE FROM CF_REALTIME_RESUMPTION")) {
      const cid = values[0] as string;
      rows.delete(cid);
      return undefined;
    }
    // chat_ctx table — replay-strategy persistence.
    if (q.startsWith("SELECT ITEM_ID, ROLE, KIND, CONTENT, POSITION FROM CF_REALTIME_CHAT_CTX")) {
      const cid = values[0] as string;
      const out = (chatCtx.get(cid) ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((r) => ({
          item_id: r.item_id,
          role: r.role,
          kind: r.kind,
          content: r.content,
          position: r.position,
        }));
      return out as T[];
    }
    if (q.startsWith("INSERT INTO CF_REALTIME_CHAT_CTX")) {
      const [connection_id, position, item_id, role, kind, content, updated_at] = values as [
        string,
        number,
        string,
        string,
        string,
        string,
        number,
      ];
      const list = chatCtx.get(connection_id) ?? [];
      list.push({ connection_id, position, item_id, role, kind, content, updated_at });
      chatCtx.set(connection_id, list);
      return undefined;
    }
    if (q.startsWith("DELETE FROM CF_REALTIME_CHAT_CTX")) {
      const cid = values[0] as string;
      chatCtx.delete(cid);
      return undefined;
    }
    return undefined;
  };
  return { sql, rows, chatCtx };
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

export interface ReplayChatCtxItem {
  itemId: string;
  role: string;
  kind: string;
  content: unknown[];
  position: number;
}

export class ReplayStubRealtimeClient implements RealtimeAudioClient {
  readonly capabilities: RealtimeCapabilities = REPLAY_STUB_CAPABILITIES;
  readonly provider = 'replay-stub';
  readonly model = 'replay-stub-v1';

  connectCalls: RealtimeSessionConfig[] = [];
  disconnectCount = 0;
  audioSent: Uint8Array[] = [];
  toolResponses: RealtimeToolResponse[][] = [];
  replayedSnapshots: ReplayChatCtxItem[][] = [];
  hydrateCalls: ReplayChatCtxItem[][] = [];
  connected = false;
  connectErrors: Error[] = [];
  /** Milliseconds `connect()` takes to resolve. Used by 5s-stable tripwire tests. */
  connectLatencyMs = 0;

  #mirror: ReplayChatCtxItem[] = [];
  #nextPos = 0;
  #listeners: Partial<{ [K in keyof RealtimeEventMap]: Set<RealtimeEventMap[K]> }> = {};
  #extraListeners = new Map<string, Set<(...args: unknown[]) => void>>();

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.connectCalls.push(config);
    if (this.connectLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.connectLatencyMs));
    }
    const err = this.connectErrors.shift();
    if (err) throw err;
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.connected = false;
    this.emit('disconnected');
  }
  sendAudio(frame: Uint8Array): void {
    this.audioSent.push(new Uint8Array(frame));
  }
  sendToolResponse(responses: RealtimeToolResponse[]): void {
    this.toolResponses.push(responses);
  }
  async updateConfig(): Promise<void> {}
  async ping(): Promise<boolean> {
    return this.connected;
  }

  snapshotChatCtx(): ReplayChatCtxItem[] {
    return this.#mirror.map((i) => ({ ...i, content: [...i.content] }));
  }
  hydrateChatCtx(items: ReplayChatCtxItem[]): void {
    this.hydrateCalls.push(items.map((i) => ({ ...i })));
    this.#mirror = items.map((i) => ({ ...i }));
    this.#nextPos = items.length ? Math.max(...items.map((i) => i.position)) + 1 : 0;
  }
  replayChatCtx(items: ReplayChatCtxItem[]): void {
    this.replayedSnapshots.push(items.map((i) => ({ ...i })));
    this.hydrateChatCtx(items);
  }

  /** Test helper — simulate a transcript arriving from the provider. */
  pushTranscript(itemId: string, role: 'user' | 'assistant', text: string): void {
    const existing = this.#mirror.find((i) => i.itemId === itemId);
    const textType = role === 'user' ? 'input_text' : 'output_text';
    if (existing) {
      existing.content = [{ type: textType, text }];
      existing.role = role;
    } else {
      this.#mirror.push({
        itemId,
        role,
        kind: 'message',
        content: [{ type: textType, text }],
        position: this.#nextPos++,
      });
    }
    this.emit('transcript', text, role);
  }

  on<K extends keyof RealtimeEventMap>(
    event: K | string,
    handler: RealtimeEventMap[K] | ((...args: unknown[]) => void),
  ): void {
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
  emit<K extends keyof RealtimeEventMap>(event: K, ...args: Parameters<RealtimeEventMap[K]>): void {
    const set = this.#listeners[event];
    if (!set) return;
    for (const h of set) (h as (...a: unknown[]) => void)(...args);
  }
  emitExtra(event: string, payload?: unknown): void {
    const set = this.#extraListeners.get(event);
    if (!set) return;
    for (const h of set) h(payload);
  }
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
