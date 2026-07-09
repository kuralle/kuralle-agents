/**
 * RealtimeAudioClient — Transport-agnostic interface for realtime voice AI models.
 *
 * Any model that accepts audio and returns audio + tool calls implements this.
 * Paired with CapabilityHost:
 * - CapabilityHost → agent logic (tools, prompts, flow state)
 * - RealtimeAudioClient → voice transport (audio I/O, tool dispatch)
 *
 * Implementations:
 * - GeminiRealtimeClient (Gemini Live, PCM16 @ 24kHz)
 * - OpenAIRealtimeClient (OpenAI Realtime, native G.711 μ-law @ 8kHz)
 * - LiveKit wraps these via @livekit/agents-plugin-google and @livekit/agents-plugin-openai
 */

import type { GeminiFunctionDeclaration } from '../capabilities/adapters/gemini.js';

// ─── Session Config ──────────────────────────────────────────────────────────

export interface RealtimeSessionConfig {
  /** System instruction / prompt for the model. */
  systemInstruction: string;
  /** Tool declarations (Gemini format — adapters convert to vendor-specific). */
  tools: GeminiFunctionDeclaration[];
  /** Voice preset (e.g., 'Puck', 'Charon', 'marin'). */
  voice?: string;
  /** Model identifier (e.g., 'gemini-3.1-flash-live-preview', 'gpt-realtime'). */
  model?: string;
  /** Session resumption handle (for reconnect continuity). */
  resumptionHandle?: string;
  /** Audio format preferences. */
  audio?: RealtimeAudioConfig;
}

export interface RealtimeAudioConfig {
  /** Input audio format. Default: 'pcm16'. */
  inputFormat?: 'pcm16' | 'pcmu' | 'pcma';
  /** Output audio format. Default: 'pcm16'. */
  outputFormat?: 'pcm16' | 'pcmu' | 'pcma';
  /** Input sample rate in Hz. Default varies by vendor (24000 for Gemini, 8000 for OpenAI G.711). */
  inputSampleRate?: number;
  /** Output sample rate in Hz. Default varies by vendor. */
  outputSampleRate?: number;
}

// ─── Tool Response ───────────────────────────────────────────────────────────

export interface RealtimeToolResponse {
  id: string;
  name: string;
  output: unknown;
}

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * Capability flags per provider. Declared at construction time; read by
 * orchestration code (VoiceEngine, RealtimeCallWorker, etc.) to adapt
 * behavior to provider limits.
 *
 * Shape mirrors LiveKit's `RealtimeCapabilities` (agents-js
 * /agents/src/llm/realtime.ts:47-58) so plugins can bridge.
 *
 * Optional flags use `undefined = not declared` semantics: an implementation
 * that omits `midSessionToolsUpdate` is treated as "not supported" by consumers
 * that check `if (caps.midSessionToolsUpdate)`. Explicit `false` means the
 * implementor confirmed the provider does not support it.
 */
export interface RealtimeCapabilities {
  /** Provider handles turn detection server-side. If false, orchestrator owns it. */
  turnDetection: boolean;
  /** Provider emits user (input) transcripts. If false, orchestrator runs STT separately. */
  userTranscription: boolean;
  /** Provider supports truncating prior messages mid-session. */
  messageTruncation: boolean;
  /** Provider auto-replies after a tool result. If false, orchestrator sends `response.create`. */
  autoToolReplyGeneration: boolean;
  /** Provider produces audio output. If false, provider is text-only and needs external TTS. */
  audioOutput: boolean;
  /** Provider supports client-driven function calls. */
  manualFunctionCalls: boolean;
  /** Mid-session updates — optional because many providers require a full reconnect. */
  midSessionChatCtxUpdate?: boolean;
  midSessionInstructionsUpdate?: boolean;
  midSessionToolsUpdate?: boolean;
  perResponseToolChoice?: boolean;
  /**
   * How this provider recovers conversation context across a WS disconnect.
   * Drives `withRealtimeVoice`'s reconnect strategy dispatch.
   *
   * - `"handle"` — server-side resumption via an opaque token (Gemini Live).
   * - `"replay"` — client-side chat_ctx replay via `conversation.item.create`
   *                (OpenAI Realtime, Azure OpenAI, xAI Grok).
   * - `"none"`   — no recovery; session starts fresh (Workers AI, Phonic, etc.).
   *
   * Omitting the field is treated as `"none"` (migration-safe for older
   * clients that predate this extension).
   */
  reconnectStrategy?: 'handle' | 'replay' | 'none';
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface RealtimeEventMap {
  /** Raw PCM audio from the model (send to client/transport). */
  audio: (data: Uint8Array) => void;
  /** Transcript of user or assistant speech. */
  transcript: (text: string, role: 'user' | 'assistant') => void;
  /** Model wants to call a tool. */
  'tool-call': (id: string, name: string, args: unknown) => void;
  /** Model finished speaking for this turn. */
  'turn-complete': () => void;
  /** User interrupted the model (barge-in). */
  interrupted: () => void;
  /** Connection error. */
  error: (error: string) => void;
  /** Connection closed. */
  disconnected: () => void;
}

// ─── Client Interface ────────────────────────────────────────────────────────

/**
 * Interface for realtime voice AI model connections.
 *
 * Lifecycle:
 * 1. connect(config) — establish WebSocket, send initial config
 * 2. sendAudio(frame) — stream user audio to model
 * 3. on('tool-call', ...) — handle tool calls from model
 * 4. sendToolResponse(...) — return tool results
 * 5. on('audio', ...) — receive model audio output
 * 6. updateConfig(...) — change prompt/tools mid-session (e.g., on flow transition)
 * 7. disconnect() — close cleanly
 *
 * NOTE: For SDK-based implementations (e.g. `@google/genai`), `session.receive()`
 * is an async iterator that completes after each turn and must be re-entered
 * inside a `while(true)` loop. Raw-wire implementations (fetch()+Upgrade on
 * Cloudflare Workers, direct `ws` WebSocket usage) do not have this quirk; the
 * underlying WebSocket stays open for the session lifetime. Future authors
 * porting this interface to a new transport should be aware that the SDK
 * wrapper and the raw-wire path diverge at this seam.
 */
export interface RealtimeAudioClient {
  /**
   * Capability flags. Static per implementation; declared at construction.
   * Implementations MUST NOT throw from this accessor.
   */
  readonly capabilities: RealtimeCapabilities;

  /** Short stable identifier for the provider, e.g. `"gemini"`, `"openai"`. */
  readonly provider: string;

  /** Model identifier configured for this client, e.g. `"gpt-realtime"`. */
  readonly model: string;

  /** Connect to the AI service with initial configuration. */
  connect(config: RealtimeSessionConfig): Promise<void>;

  /** Disconnect gracefully. */
  disconnect(): Promise<void>;

  /** Send a PCM audio frame to the model. */
  sendAudio(frame: Uint8Array): void;

  /** Send tool call results back to the model. */
  sendToolResponse(responses: RealtimeToolResponse[]): void;

  /**
   * Update session configuration mid-call (system prompt, tools).
   * Used when CapabilityHost signals 'reconfigure' after a flow transition.
   *
   * Implementation may:
   * - Send in-place update (if model supports it)
   * - Disconnect and reconnect with new config (fallback)
   * - Use session resumption handle for continuity
   */
  updateConfig(config: Partial<RealtimeSessionConfig>): Promise<void>;

  /**
   * Trigger a model response after config update.
   * Optional — not all providers support it.
   */
  requestResponse?(instruction?: string): void;

  /** Check connection health (WebSocket ping). */
  ping(): Promise<boolean>;

  /** Subscribe to events from the model. */
  on<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void;

  /** Unsubscribe from events. */
  off<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void;

  /** Whether currently connected to the model. */
  readonly connected: boolean;
}
