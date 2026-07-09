/**
 * CloudflareGeminiLiveClient — Workers-native Gemini Live provider.
 *
 * Speaks the Gemini Live wire protocol directly via
 *   `fetch(url, { headers: { Upgrade: "websocket" } })`
 * No `@google/genai`, no `ws`. Sibling to Node's `GeminiLiveSession`.
 * Satisfies `RealtimeAudioClient` v2 with capabilities + provider + model.
 */

/// <reference path="./workers-env.d.ts" />

import type {
  RealtimeAudioClient,
  RealtimeCapabilities,
  RealtimeSessionConfig,
  RealtimeToolResponse,
  RealtimeEventMap,
} from '@kuralle-agents/core/realtime';
import { GEMINI_CAPABILITIES } from '../gemini/common.js';
import { debug } from '../debug.js';
import { encodeBase64Chunked, decodeBase64 } from './base64.js';
import { decodeCFWorkerMessageData } from './ws-message.js';
export { encodeBase64Chunked, decodeBase64 } from './base64.js';

// ─── Constants ──────────────────────────────────────────────────────────────

// Workers' `fetch()` requires https:// (not wss://) + `Upgrade: websocket` header.
// workerd promotes to a WebSocket by returning `response.webSocket`. Using wss://
// triggers `TypeError: Fetch API cannot load` before any handshake.
const BIDI_URL =
  'https://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_VOICE = 'Charon'; // LB-3 resolved 2026-04-22 — neutral default across agent types
const DEFAULT_TURN_COVERAGE = 'TURN_INCLUDES_ONLY_ACTIVITY' as const;
const INPUT_AUDIO_MIME = 'audio/pcm;rate=16000';

// ─── Options ────────────────────────────────────────────────────────────────

export interface CloudflareGeminiLiveOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  responseModalities?: ('AUDIO' | 'TEXT')[];
  enableInputTranscription?: boolean;
  enableOutputTranscription?: boolean;
  contextWindowCompression?: boolean;
  turnCoverage?: 'TURN_INCLUDES_ONLY_ACTIVITY' | 'TURN_INCLUDES_ALL_INPUT';
}

// ─── Helpers — base64 ───────────────────────────────────────────────────────

// ─── Audio helpers ──────────────────────────────────────────────────────────

/**
 * Downsample 24kHz PCM16 LE → 16kHz PCM16 LE via 3:2 decimation + averaging.
 *
 * `@cloudflare/voice`'s client hardcodes PCM16 playback at 16kHz
 * (voice-client.ts:718), ignoring `audio_config.sampleRate`. Gemini Live emits
 * 24kHz; without conversion audio plays 1.5× slowed ("bass-heavy"). We convert
 * server-side so the existing client works unmodified.
 */
function downsample24kTo16k(input24kBytes: Uint8Array): Uint8Array {
  const input = new Int16Array(input24kBytes.buffer, input24kBytes.byteOffset, input24kBytes.byteLength / 2);
  // 3 in → 2 out. For every 3-sample window: output two averaged samples.
  //   out[0] = (in[0] + in[1]) / 2
  //   out[1] = (in[1] + in[2]) / 2
  const outLen = Math.floor((input.length * 2) / 3);
  const output = new Int16Array(outLen);
  let oi = 0;
  for (let i = 0; i + 2 < input.length; i += 3) {
    if (oi >= outLen) break;
    output[oi++] = (input[i] + input[i + 1]) >> 1;
    if (oi >= outLen) break;
    output[oi++] = (input[i + 1] + input[i + 2]) >> 1;
  }
  return new Uint8Array(output.buffer, 0, outLen * 2);
}

// ─── Gemini schema sanitizer ────────────────────────────────────────────────

/**
 * Gemini Live parses tool-parameter schemas via Protobuf Struct, NOT full JSON
 * Schema. Fields emitted by `zod-to-json-schema` like `additionalProperties`,
 * `$schema`, `$defs`, `$ref` cause the server to reject the setup frame with
 * `code=1007 reason="Invalid JSON payload received. Unknown name …"`. Strip
 * them recursively; keep the subset Gemini supports (type / description /
 * properties / required / items / enum).
 */
function sanitizeForGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeForGeminiSchema);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'additionalProperties') continue;
      if (k === '$schema') continue;
      if (k === '$defs') continue;
      if (k === '$ref') continue;
      if (k === 'definitions') continue;
      out[k] = sanitizeForGeminiSchema(v);
    }
    return out;
  }
  return node;
}

// ─── Setup frame builder (pure function — unit-testable) ────────────────────

/**
 * Build the Gemini Live `setup` frame from options + session config.
 * Pure function: takes no network, no I/O. Snapshot-tested.
 */
export function buildSetupFrame(
  opts: CloudflareGeminiLiveOptions,
  sessionConfig: RealtimeSessionConfig,
  model: string,
): Record<string, unknown> {
  const voice = opts.voice ?? DEFAULT_VOICE;
  const responseModalities = opts.responseModalities ?? ['AUDIO'];
  const turnCoverage = opts.turnCoverage ?? DEFAULT_TURN_COVERAGE;
  const enableInput = opts.enableInputTranscription ?? true;
  const enableOutput = opts.enableOutputTranscription ?? true;
  const enableCompression = opts.contextWindowCompression ?? true;

  const setup: Record<string, unknown> = {
    model: `models/${model}`,
    generationConfig: {
      responseModalities,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
    realtimeInputConfig: { turnCoverage },
  };

  if (sessionConfig.systemInstruction) {
    setup.systemInstruction = { parts: [{ text: sessionConfig.systemInstruction }] };
  }

  if (sessionConfig.tools?.length) {
    // Gemini Live uses Protobuf Struct (strict); it rejects JSON-Schema extras
    // that Zod's converter emits (`additionalProperties`, `$schema`, `$defs`, `$ref`).
    // Strip them recursively on every tool's parameters before wire.
    const sanitized = sessionConfig.tools.map((t) => ({
      ...t,
      parameters: sanitizeForGeminiSchema(t.parameters),
    }));
    setup.tools = [{ functionDeclarations: sanitized }];
  }

  if (enableInput) setup.inputAudioTranscription = {};
  if (enableOutput) setup.outputAudioTranscription = {};
  if (enableCompression) setup.contextWindowCompression = { slidingWindow: {} };

  setup.sessionResumption = sessionConfig.resumptionHandle
    ? { handle: sessionConfig.resumptionHandle }
    : { handle: null };

  return { setup };
}

// ─── Client ─────────────────────────────────────────────────────────────────

type RealtimeHandler = RealtimeEventMap[keyof RealtimeEventMap];

export class CloudflareGeminiLiveClient implements RealtimeAudioClient {
  readonly capabilities: RealtimeCapabilities = GEMINI_CAPABILITIES;
  readonly provider: string = 'gemini';
  readonly model: string;

  private ws: CFWorkerWebSocket | null = null;
  private pending: Uint8Array[] = [];
  private ready = false;
  private closed = false;
  private setupResolver: (() => void) | null = null;
  private frameLogCount = 0;
  private audioFrameLogCount = 0;
  private lastHandle: string | null = null;
  private readonly listeners: Map<keyof RealtimeEventMap, Set<RealtimeHandler>> = new Map();
  private readonly opts: CloudflareGeminiLiveOptions;

  constructor(opts: CloudflareGeminiLiveOptions) {
    if (!opts.apiKey) throw new Error('CloudflareGeminiLiveClient: apiKey is required');
    this.opts = opts;
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  get connected(): boolean {
    return this.ready && !this.closed;
  }

  /** Last session-resumption handle captured from the server. */
  get sessionResumptionHandle(): string | null {
    return this.lastHandle;
  }

  // ─── RealtimeAudioClient — events ─────────────────────────────────────────

  on<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit<K extends keyof RealtimeEventMap>(
    event: K,
    ...args: Parameters<RealtimeEventMap[K]>
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const h of set) {
      (h as (...a: Parameters<RealtimeEventMap[K]>) => void)(...args);
    }
  }

  async ping(): Promise<boolean> {
    return this.ws?.readyState === 1;
  }

  // ─── Connect / disconnect ─────────────────────────────────────────────────

  async connect(config: RealtimeSessionConfig): Promise<void> {
    debug('[gemini-live] connect() entered');
    const url = `${BIDI_URL}?key=${this.opts.apiKey ? '<present>' : '<MISSING>'}`;
    debug('[gemini-live] url (sanitized):', url.replace(/\?key=.*/, '?key=<redacted>'));

    const resp = (await fetch(`${BIDI_URL}?key=${this.opts.apiKey}`, {
      headers: { Upgrade: 'websocket' },
    })) as CFWorkerUpgradeResponse;
    debug('[gemini-live] fetch returned, status:', resp.status, 'hasWebSocket:', !!resp.webSocket);

    const ws = resp.webSocket;
    if (!ws) {
      console.error('[gemini-live] no webSocket on fetch response — Gemini likely rejected the upgrade. status=', resp.status);
      throw new Error(
        `CloudflareGeminiLiveClient: Workers runtime did not return a WebSocket (status=${resp.status}). Gemini Live requires fetch-Upgrade + valid API key + model access.`,
      );
    }

    ws.accept();
    this.ws = ws;
    // Force binary frames to arrive as ArrayBuffer, not Blob (workerd's default
    // for outbound WebSockets matches the browser default; Gemini sends text
    // frames that workerd wraps as Blob unless we override here).
    try { ws.binaryType = 'arraybuffer'; } catch { /* ignore if not settable */ }
    debug('[gemini-live] ws.accept() ok; binaryType=arraybuffer; attaching listeners');

    let setupRejector: ((err: Error) => void) | null = null;

    ws.addEventListener('message', (event) => {
      // Fire-and-forget — handleFrame may be async when event.data is a Blob.
      void this.handleFrame(event);
    });
    ws.addEventListener('close', (event: CFWorkerWebSocketCloseEvent) => {
      const code = event.code;
      const reason = event.reason;
      debug('[gemini-live] ws close: code=', code, 'reason=', reason);
      this.ready = false;
      this.emit('disconnected');
      if (setupRejector) {
        setupRejector(new Error(`Gemini Live WS closed before setupComplete. code=${code} reason=${reason ?? '(none)'}`));
        setupRejector = null;
      }
    });
    ws.addEventListener('error', (event: CFWorkerWebSocketErrorEvent) => {
      const detail = JSON.stringify({
        type: event.type,
        message: event.message,
        errorType: event.error?.constructor?.name,
        errorMessage: event.error?.message,
        errorStack: (event.error as Error | undefined)?.stack,
        reason: event.reason,
        code: event.code,
      });
      console.error('[gemini-live] ws error detail:', detail);
      this.emit('error', detail);
      if (setupRejector) {
        setupRejector(new Error(`Gemini Live WS error before setupComplete: ${detail}`));
        setupRejector = null;
      }
    });

    // Send setup frame and wait for setupComplete before acknowledging connect().
    const model = config.model ?? this.model;
    const setupFrame = buildSetupFrame(this.opts, config, model);
    debug('[gemini-live] sending setup frame, model:', model);
    ws.send(JSON.stringify(setupFrame));

    await new Promise<void>((resolve, reject) => {
      this.setupResolver = resolve;
      setupRejector = reject;
    });
    setupRejector = null;
    debug('[gemini-live] setupComplete received; ready');

    this.ready = true;

    // Drain audio queued before setupComplete arrived.
    const queued = this.pending;
    this.pending = [];
    for (const frame of queued) this.sendAudio(frame);
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.ready = false;
    try {
      this.ws?.close();
    } catch {
      // ignore — ws may already be closing
    }
    this.ws = null;
  }

  /**
   * Gemini Live does not support in-place session updates. Callers should
   * disconnect and reconnect with a new `RealtimeSessionConfig`, optionally
   * reusing `sessionResumptionHandle` for context continuity. Intentionally
   * a no-op here so existing RealtimeAudioClient consumers don't crash.
   */
  async updateConfig(_config: Partial<RealtimeSessionConfig>): Promise<void> {
    // no-op. See docstring.
  }

  // ─── Send audio / tool response ───────────────────────────────────────────

  sendAudio(frame: Uint8Array): void {
    if (this.closed) return;
    if (!this.ready || !this.ws) {
      this.pending.push(frame);
      return;
    }
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: encodeBase64Chunked(frame), mimeType: INPUT_AUDIO_MIME },
        },
      }),
    );
  }

  sendToolResponse(responses: RealtimeToolResponse[]): void {
    if (!this.ws) return;
    this.ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: responses.map((r) => ({
            id: r.id,
            name: r.name,
            // Google's exact envelope — `response: { result: output }` — NOT raw output.
            // Captured verbatim from gemini_live.py reference.
            response: { result: r.output },
          })),
        },
      }),
    );
  }

  // ─── Frame dispatcher ─────────────────────────────────────────────────────

  /** Exposed for unit testing. Accepts either a parsed frame or raw event data. */
  dispatchFrame(frame: Record<string, unknown>): void {
    // Log first 3 frames (not the full stream — setupComplete + first couple turn events).
    // Enough to diagnose startup without flooding wrangler tail.
    if (this.frameLogCount < 3) {
      const preview = JSON.stringify(frame).slice(0, 300);
      debug(`[gemini-live] frame #${this.frameLogCount}:`, preview);
      this.frameLogCount++;
    }

    if (frame.setupComplete) {
      debug('[gemini-live] setupComplete frame matched');
      this.setupResolver?.();
      this.setupResolver = null;
    }

    const serverContent = frame.serverContent as
      | {
          modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          turnComplete?: boolean;
          generationComplete?: boolean;
          interrupted?: boolean;
        }
      | undefined;

    if (serverContent) {
      for (const part of serverContent.modelTurn?.parts ?? []) {
        const mime = part.inlineData?.mimeType;
        const data = part.inlineData?.data;
        // Log first two audio frames with mime for diagnosis of rate/format.
        if (mime && this.audioFrameLogCount < 2) {
          debug(`[gemini-live] audio frame mime=${mime}, base64 len=${data?.length ?? 0}`);
          this.audioFrameLogCount++;
        }
        if (mime?.startsWith('audio/pcm') && typeof data === 'string') {
          const pcm24k = decodeBase64(data);
          // `@cloudflare/voice` client plays PCM16 hardcoded at 16kHz.
          // Gemini emits 24kHz. Downsample 24→16 server-side (3:2 ratio).
          const pcm16k = downsample24kTo16k(pcm24k);
          this.emit('audio', pcm16k);
        }
      }
      const it = serverContent.inputTranscription?.text;
      if (it) this.emit('transcript', it, 'user');
      const ot = serverContent.outputTranscription?.text;
      if (ot) this.emit('transcript', ot, 'assistant');
      // `turnComplete` and `generationComplete` both mark end-of-turn per wire docs.
      if (serverContent.turnComplete || serverContent.generationComplete) {
        this.emit('turn-complete');
      }
      if (serverContent.interrupted) this.emit('interrupted');
    }

    const toolCall = frame.toolCall as
      | { functionCalls?: Array<{ id: string; name: string; args?: unknown }> }
      | undefined;
    if (toolCall?.functionCalls) {
      for (const fc of toolCall.functionCalls) {
        this.emit('tool-call', fc.id, fc.name, fc.args);
      }
    }

    const resumption = frame.sessionResumptionUpdate as
      | { resumable?: boolean; newHandle?: string }
      | undefined;
    if (resumption?.resumable && resumption.newHandle) {
      this.lastHandle = resumption.newHandle;
    }

    // `goAway` — Gemini's 15-minute audio-only cap signal. Surface so
    // the realtime voice mixin can reconnect with the captured resumption handle. We
    // don't have a typed RealtimeEventMap event yet, so
    // callers observe via `sessionResumptionHandle` + `disconnected`.
  }

  private async handleFrame(event: CFWorkerMessageEvent): Promise<void> {
    const raw = event.data;

    let text: string;
    try {
      const decoded = await decodeCFWorkerMessageData(raw);
      if (decoded === null) {
        console.error(
          '[gemini-live] unrecognized event.data shape:',
          typeof raw,
          raw && Object.prototype.toString.call(raw),
        );
        return;
      }
      text = decoded;
    } catch (decodeErr) {
      console.error(
        '[gemini-live] frame decode failed:',
        (decodeErr as Error).message,
        'raw type:',
        typeof raw,
        Object.prototype.toString.call(raw),
      );
      return;
    }

    // Log first 10 frames for diagnosis — enough to see setupComplete + several
    // model-turn / transcription frames without flooding logs.
    if (this.frameLogCount < 10) {
      // Redact base64 audio payloads (big, noisy); keep everything else.
      const preview = text.length > 600
        ? text.replace(/"data":"[A-Za-z0-9+/=]+"/g, '"data":"<base64 redacted>"').slice(0, 600)
        : text;
      debug(`[gemini-live] frame #${this.frameLogCount} preview:`, preview);
      this.frameLogCount++;
    }

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      this.emit('error', `Invalid JSON frame: ${(err as Error).message}`);
      return;
    }
    this.dispatchFrame(frame);
  }
}
