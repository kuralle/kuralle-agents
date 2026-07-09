/**
 * OpenAIFamilyRealtimeClient — Cloudflare-Workers-native base for the OpenAI
 * Realtime family (OpenAI + Azure OpenAI + xAI Grok). Three vendor classes
 * compose `ProviderProfile` in; one implementation, three flavors.
 *
 * Differences from `CloudflareGeminiLiveClient`:
 *   - Auth is via WS subprotocol list, not URL query param. Workers `fetch()`
 *     does not accept a `Sec-WebSocket-Protocol` header — it must be attached
 *     via the 3rd argument of `new WebSocket(url, protocols)`. Since workerd's
 *     fetch-upgrade path does surface a WebSocket object, we build the
 *     protocols string and include it in the Upgrade headers directly.
 *   - Reconnect is replay-based, not handle-based. We don't
 *     drive reconnect here — the realtime voice mixin owns the retry loop and
 *     calls `snapshotChatCtx()` / `replayChatCtx(items)` on us.
 *   - We maintain an outbound queue that buffers `sendAudio` / tool replies
 *     while the socket is absent (e.g. between `connect()` entry and
 *     `session.updated` arrival). Matches LiveKit's `messageChannel` pattern.
 */

/// <reference path="../workers-env.d.ts" />

import type {
  RealtimeAudioClient,
  RealtimeCapabilities,
  RealtimeEventMap,
  RealtimeSessionConfig,
  RealtimeToolResponse,
} from '@kuralle-agents/core/realtime';
import { ChatCtxMirror, type ChatCtxItem } from './chat-ctx-mirror.js';
import {
  buildAudioAppend,
  buildResponseCancel,
  buildSessionUpdate,
  buildToolResponseFrames,
  canonicalizeEventName,
  OPENAI_FAMILY_CAPABILITIES,
  type ProviderProfile,
  type TurnDetection,
} from './protocol.js';
import { OpenAIFamilySessionState } from './session-state.js';
import { OpenAIFamilyMessageQueue } from './message-queue.js';
import { encodeBase64Chunked, decodeBase64 } from '../base64.js';
import { decodeCFWorkerMessageData } from '../ws-message.js';
import { debug } from '../../debug.js';
export { encodeBase64Chunked, decodeBase64 } from '../base64.js';

const INPUT_RATE = 24000;
const OUTPUT_RATE = 24000;
const DEFAULT_ROLLOVER_MS = 25 * 60_000;

export interface OpenAIFamilyOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  /**
   * Full turn_detection object. Accepts either:
   *   - a shorthand type string (kept for ergonomics — filled from profile's
   *     full default when used, so semantic_vad picks up `eagerness: medium`
   *     and create_response/interrupt_response defaults),
   *   - OR a complete TurnDetection object to override every field.
   *
   * Defaults to the provider profile's `turnDetectionDefault`, which mirrors
   * `@livekit/agents-plugin-openai` per-provider defaults.
   */
  turnDetection?: TurnDetection | 'server_vad' | 'semantic_vad';
  /**
   * Milliseconds after `connect()` resolves until a synthetic `rolloverDue`
   * event fires. Default 25 minutes — safely under OpenAI's 60-min cap and
   * Azure's 30-min cap. 0 disables.
   */
  rolloverAfterMs?: number;
  /** Max events held in the outbound queue while disconnected. Default 256. */
  sendQueueMaxEvents?: number;
  /** Max bytes held in the outbound queue. Default 1 MiB. */
  sendQueueMaxBytes?: number;
}

type RealtimeHandler = RealtimeEventMap[keyof RealtimeEventMap];
type ExtraHandler = (...args: unknown[]) => void;
type ClientHandler = RealtimeHandler | ExtraHandler;

/**
 * Supplementary (non-RealtimeEventMap) events this client emits. Consumed by
 * `withRealtimeVoice` via the opportunistic `on(event, handler)` path.
 *
 *   rolloverDue    — proactive rollover timer fired; mixin should reconnect.
 */
export type OpenAIFamilyExtraEvent = 'rolloverDue';

// ─── Client ─────────────────────────────────────────────────────────────────

export class OpenAIFamilyRealtimeClient implements RealtimeAudioClient {
  readonly capabilities: RealtimeCapabilities = OPENAI_FAMILY_CAPABILITIES;
  readonly provider: string;
  readonly model: string;

  #profile: ProviderProfile;
  #opts: OpenAIFamilyOptions;
  #ws: CFWorkerWebSocket | null = null;
  #state = new OpenAIFamilySessionState();
  #queue: OpenAIFamilyMessageQueue;
  #mirror = new ChatCtxMirror();
  #listeners = new Map<string, Set<ClientHandler>>();
  #sessionUpdatedResolver: (() => void) | null = null;
  #sessionUpdatedRejector: ((err: Error) => void) | null = null;
  #rolloverTimer: ReturnType<typeof setTimeout> | null = null;
  #audioCapableItemIds = new Set<string>();
  #frameLogCount = 0;

  constructor(profile: ProviderProfile, opts: OpenAIFamilyOptions) {
    if (!opts.apiKey) {
      throw new Error('OpenAIFamilyRealtimeClient: apiKey is required');
    }
    this.#profile = profile;
    this.#opts = opts;
    this.provider = profile.provider;
    this.model = opts.model ?? profile.modelDefault;
    this.#queue = new OpenAIFamilyMessageQueue({
      maxEvents: opts.sendQueueMaxEvents,
      maxBytes: opts.sendQueueMaxBytes,
    });
  }

  // ─── Event API ────────────────────────────────────────────────────────────

  on<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void;
  on(event: OpenAIFamilyExtraEvent, handler: (...args: unknown[]) => void): void;
  on(event: string, handler: ClientHandler): void {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event)!.add(handler);
  }

  off<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    this.#listeners.get(event)?.delete(handler);
  }

  #emit(event: string, ...args: unknown[]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        (h as ExtraHandler)(...args);
      } catch (err) {
        console.error('[openai-family] listener threw for event=', event, 'err=', String(err));
      }
    }
  }

  async ping(): Promise<boolean> {
    return this.#ws?.readyState === 1;
  }

  get connected(): boolean {
    return this.#state.isActive && this.#ws !== null;
  }

  // ─── Chat-ctx mirror accessors ────────────────────────────────────────────

  snapshotChatCtx(): ChatCtxItem[] {
    return this.#mirror.snapshot();
  }

  hydrateChatCtx(items: ChatCtxItem[]): void {
    this.#mirror.hydrate(items);
  }

  /**
   * Re-emit a persisted chat_ctx on a fresh session. MUST be called AFTER
   * `session.updated` has arrived on the new WS but BEFORE any user audio is
   * streamed. The realtime voice mixin gates `sendAudio` accordingly.
   */
  replayChatCtx(items: ChatCtxItem[]): void {
    this.#mirror.hydrate(items);
    const frames = this.#mirror.toCreateFrames();
    for (const frame of frames) {
      // Bypass the queue — replay is strictly ordered and must go on the wire
      // immediately after `session.update`. LiveKit's realtime_model.ts:1011
      // does the same via raw `wsConn.send(...)`.
      this.#wsSendRaw(JSON.stringify(frame));
    }
  }

  // ─── Connect / disconnect ─────────────────────────────────────────────────

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.#state.beginConnect('OpenAIFamilyRealtimeClient');

    const url = this.#profile.buildUrl(this.model);
    const subprotocols = this.#profile.buildSubprotocols(this.#opts.apiKey);

    debug(
      '[openai-family] connect(): provider=',
      this.provider,
      'model=',
      this.model,
      'state=',
      this.#state.current,
    );

    // Use `new WebSocket(url, protocols)` rather than `fetch() + Upgrade`.
    // Workerd's fetch-upgrade path does NOT forward a custom
    // `Sec-WebSocket-Protocol` header to the origin — the only way to pass a
    // subprotocol list on Workers is via the native WebSocket constructor.
    // This is also what `@openai/agents-realtime/shims/shims-workerd.ts` does.
    let ws: CFWorkerWebSocket;
    try {
      // workerd WebSocket is CFWorkerWebSocket; lib.dom WebSocket lacks accept()
      // @ts-expect-error CF workerd WebSocket extends DOM WebSocket with accept()
      ws = new WebSocket(url, subprotocols);
    } catch (err) {
      this.#state.reset();
      throw new Error(`OpenAIFamilyRealtimeClient: WebSocket construct failed — ${String(err)}`);
    }

    this.#ws = ws;
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      /* workerd may not allow override; we handle Blob path in #handleFrame */
    }

    // Wait for the socket to open before sending. `new WebSocket(url, ...)`
    // is asynchronous; sending before the handshake completes throws
    // `You must call one of accept()...` on workerd. Attach listeners first
    // (so we don't miss early server frames), then wait for 'open'.
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const onOpen = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const onErr = (evt: CFWorkerWebSocketErrorEvent) => {
        if (done) return;
        done = true;
        const detail = JSON.stringify({
          message: evt.message,
          code: evt.code,
          reason: evt.reason,
        });
        reject(new Error(`WebSocket error during open: ${detail}`));
      };
      try {
        ws.addEventListener('open', onOpen);
      } catch {
        /* some shims don't support addEventListener('open') — fall through */
      }
      ws.addEventListener('error', onErr);
      ws.addEventListener('close', (evt: CFWorkerWebSocketCloseEvent) => {
        if (done) return;
        done = true;
        reject(new Error(`WebSocket closed during open handshake: code=${evt.code}`));
      });
    });
    debug('[openai-family] WS open');

    ws.addEventListener('message', (event) => {
      void this.#handleFrame(event);
    });
    ws.addEventListener('close', (event: CFWorkerWebSocketCloseEvent) => {
      const code = event.code;
      const reason = event.reason;
      debug('[openai-family] ws close: code=', code, 'reason=', reason);
      this.#teardownSocket();
      this.#emit('disconnected');
      if (this.#sessionUpdatedRejector) {
        this.#sessionUpdatedRejector(
          new Error(`WS closed before session.updated. code=${code} reason=${reason ?? '(none)'}`),
        );
        this.#sessionUpdatedRejector = null;
        this.#sessionUpdatedResolver = null;
      }
    });
    ws.addEventListener('error', (event: CFWorkerWebSocketErrorEvent) => {
      const detail = JSON.stringify({
        type: event.type,
        message: event.message,
        errorMessage: event.error?.message,
        reason: event.reason,
        code: event.code,
      });
      console.error('[openai-family] ws error:', detail);
      this.#emit('error', detail);
      if (this.#sessionUpdatedRejector) {
        this.#sessionUpdatedRejector(new Error(`WS error before session.updated: ${detail}`));
        this.#sessionUpdatedRejector = null;
        this.#sessionUpdatedResolver = null;
      }
    });

    // Send session.update immediately; wait for session.updated before unblocking.
    const voice = this.#opts.voice ?? this.#profile.voiceDefault;
    const turnDetection = this.#resolveTurnDetection();
    const frame = buildSessionUpdate({
      model: this.model,
      voice,
      turnDetection,
      inputAudioRate: INPUT_RATE,
      outputAudioRate: OUTPUT_RATE,
      systemInstruction: config.systemInstruction,
      tools: config.tools,
    });
    this.#wsSendRaw(JSON.stringify(frame));
    debug('[openai-family] sent session.update, awaiting session.updated');

    await new Promise<void>((resolve, reject) => {
      this.#sessionUpdatedResolver = resolve;
      this.#sessionUpdatedRejector = reject;
    });
    this.#sessionUpdatedResolver = null;
    this.#sessionUpdatedRejector = null;
    this.#state.markActive();

    this.#drainQueue();
    this.#scheduleRollover();
    debug('[openai-family] connect() complete, state=ACTIVE');
  }

  async disconnect(): Promise<void> {
    this.#state.beginClose();
    this.#clearRollover();
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        /* already closing */
      }
    }
    this.#teardownSocket();
    this.#state.reset();
  }

  #teardownSocket(): void {
    this.#ws = null;
    this.#state.onSocketGone();
  }

  async updateConfig(config: Partial<RealtimeSessionConfig>): Promise<void> {
    // OpenAI family supports mid-session updates via session.update.
    if (!this.#state.isActive) return;
    const voice = this.#opts.voice ?? this.#profile.voiceDefault;
    const turnDetection = this.#resolveTurnDetection();
    const frame = buildSessionUpdate({
      model: this.model,
      voice,
      turnDetection,
      inputAudioRate: INPUT_RATE,
      outputAudioRate: OUTPUT_RATE,
      systemInstruction: config.systemInstruction,
      tools: config.tools,
    });
    this.#wsSendRaw(JSON.stringify(frame));
  }

  /**
   * Resolve `opts.turnDetection` to a full `TurnDetection` object. If the
   * caller passed a shorthand string, the profile's default (for that type)
   * is used so the schema is always complete — explicit `create_response`,
   * `eagerness`, thresholds, etc. Callers can still pass a full object to
   * override any field.
   */
  #resolveTurnDetection(): TurnDetection {
    const opt = this.#opts.turnDetection;
    if (!opt) return this.#profile.turnDetectionDefault;
    if (typeof opt === 'string') {
      // Shorthand: caller gave 'semantic_vad' | 'server_vad'. Use the profile
      // default if its type matches; otherwise synthesize a minimum-viable
      // shape so we don't fall back to OpenAI's `eagerness: 'auto'` trap.
      const def = this.#profile.turnDetectionDefault;
      if (def.type === opt) return def;
      if (opt === 'semantic_vad') {
        return { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true };
      }
      if (opt === 'server_vad') {
        return {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200,
          create_response: true,
          interrupt_response: true,
        };
      }
    }
    return opt as TurnDetection;
  }

  // ─── Send audio / tool response ───────────────────────────────────────────

  sendAudio(frame: Uint8Array): void {
    if (this.#state.isQuiescent) return;
    const encoded = encodeBase64Chunked(frame);
    this.#enqueue(JSON.stringify(buildAudioAppend(encoded)));
  }

  sendToolResponse(responses: RealtimeToolResponse[]): void {
    if (this.#state.isQuiescent) return;
    for (const f of buildToolResponseFrames(responses)) {
      this.#enqueue(JSON.stringify(f));
    }
  }

  /**
   * Client-initiated interrupt. Sends `response.cancel` and optionally a
   * `conversation.item.truncate` if the assistant had begun speaking. The
   * truncate is skipped for items restored by replay (audio-capable only
   * for items originated in the current session).
   */
  sendInterrupt(): void {
    this.#enqueue(JSON.stringify(buildResponseCancel()));
  }

  // ─── Queue + wire helpers ─────────────────────────────────────────────────

  #enqueue(serialized: string): void {
    if (this.#state.isActive && this.#ws) {
      this.#wsSendRaw(serialized);
      return;
    }
    this.#queue.push(serialized);
  }

  #drainQueue(): void {
    if (!this.#ws) return;
    for (const s of this.#queue.drain()) this.#wsSendRaw(s);
  }

  #wsSendRaw(s: string): void {
    try {
      this.#ws?.send(s);
    } catch (err) {
      console.error('[openai-family] wsSendRaw failed:', String(err));
    }
  }

  // ─── Rollover ─────────────────────────────────────────────────────────────

  #scheduleRollover(): void {
    const after = this.#opts.rolloverAfterMs ?? DEFAULT_ROLLOVER_MS;
    if (after <= 0) return;
    this.#rolloverTimer = setTimeout(() => {
      debug('[openai-family] rolloverDue fired after', after, 'ms');
      this.#emit('rolloverDue');
    }, after);
  }

  #clearRollover(): void {
    if (this.#rolloverTimer) {
      clearTimeout(this.#rolloverTimer);
      this.#rolloverTimer = null;
    }
  }

  // ─── Frame dispatch ───────────────────────────────────────────────────────

  /** Public for unit tests. */
  dispatchFrame(frame: Record<string, unknown>): void {
    const rawType = typeof frame.type === 'string' ? frame.type : '';
    const canonical = canonicalizeEventName(rawType);

    if (this.#frameLogCount < 10) {
      const preview = JSON.stringify(frame).slice(0, 300);
      debug(`[openai-family] frame #${this.#frameLogCount} type=${canonical}:`, preview);
      this.#frameLogCount++;
    }

    switch (canonical) {
      case 'session.created':
        // Informational — session.updated is the one we await.
        return;
      case 'session.updated':
        this.#sessionUpdatedResolver?.();
        return;
      case 'response.output_audio.delta': {
        const delta = (frame as { delta?: string }).delta;
        if (typeof delta === 'string') {
          this.#emit('audio', decodeBase64(delta));
        }
        return;
      }
      case 'response.output_audio_transcript.delta': {
        const delta = (frame as { delta?: string }).delta;
        if (typeof delta === 'string') this.#emit('transcript', delta, 'assistant');
        return;
      }
      case 'response.output_audio_transcript.done': {
        const text = (frame as { transcript?: string }).transcript;
        const itemId = (frame as { item_id?: string }).item_id;
        if (typeof text === 'string' && itemId) {
          this.#mirror.applyTranscript(itemId, 'assistant', text);
        }
        return;
      }
      case 'conversation.item.added': {
        const item = (frame as { item?: Record<string, unknown> }).item;
        if (item && typeof item.id === 'string') {
          const id = item.id as string;
          this.#audioCapableItemIds.add(id);
          this.#mirror.upsert({
            id,
            type: item.type as string | undefined,
            role: item.role as string | undefined,
            content: item.content as unknown[] | undefined,
          });
        }
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (frame as { transcript?: string }).transcript;
        const itemId = (frame as { item_id?: string }).item_id;
        if (typeof text === 'string' && itemId) {
          this.#emit('transcript', text, 'user');
          this.#mirror.applyTranscript(itemId, 'user', text);
        }
        return;
      }
      case 'response.output_item.done': {
        const item = (frame as { item?: Record<string, unknown> }).item;
        if (item && item.type === 'function_call') {
          const callId = item.call_id as string | undefined;
          const name = item.name as string | undefined;
          const argsRaw = item.arguments as string | undefined;
          let args: unknown = {};
          try {
            if (argsRaw) args = JSON.parse(argsRaw);
          } catch {
            args = {};
          }
          if (callId && name) {
            this.#emit('tool-call', callId, name, args);
          }
        }
        return;
      }
      case 'response.done':
        this.#emit('turn-complete');
        return;
      case 'input_audio_buffer.speech_started':
        // Server VAD detected user speech — mixin treats this as interrupt.
        this.#emit('interrupted');
        return;
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
      case 'rate_limits.updated':
      case 'response.created':
      case 'response.output_item.added':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_text.delta':
      case 'response.output_text.done':
      case 'response.output_audio.done':
      case 'conversation.item.input_audio_transcription.failed':
        // Known but unsurfaced — surface selectively later.
        return;
      case 'error': {
        const err = (frame as { error?: { message?: string; code?: string } }).error;
        const msg = err?.message ?? 'unknown error';
        this.#emit('error', msg);
        return;
      }
      default:
        // Silently ignore unknown events — GA / Beta drift is expected.
        return;
    }
  }

  async #handleFrame(event: CFWorkerMessageEvent): Promise<void> {
    const raw = event.data;
    let text: string;
    try {
      const decoded = await decodeCFWorkerMessageData(raw);
      if (decoded === null) {
        console.error('[openai-family] unrecognized event.data shape');
        return;
      }
      text = decoded;
    } catch (err) {
      console.error('[openai-family] frame decode failed:', (err as Error).message);
      return;
    }

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      this.#emit('error', `Invalid JSON frame: ${(err as Error).message}`);
      return;
    }
    this.dispatchFrame(frame);
  }
}
