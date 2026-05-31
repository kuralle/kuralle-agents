/**
 * Canonical client-server wire protocol for Kuralle voice transports.
 *
 * This is a verbatim lift of @cloudflare/voice's protocol v1
 * (see NOTICE for Apache-2.0 attribution). Published here so every
 * Kuralle transport (Cloudflare DO, Node WS, LiveKit-translated, SIP,
 * Twilio) can emit identical frames. Any client consuming this contract
 * (e.g. useVoiceAgent from @cloudflare/voice/react) works against all
 * Kuralle transports unmodified.
 */

// --- Protocol version ---

/**
 * Current voice protocol version.
 * Bump this when making backwards-incompatible wire protocol changes.
 * The server sends this in the initial `welcome` message so clients
 * can detect version mismatches.
 */
export const VOICE_PROTOCOL_VERSION = 1;

// --- Voice status ---

export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

// --- Audio format ---

/**
 * Audio format the server uses for binary audio payloads.
 *
 * - `mp3` / `wav` / `opus`: container-framed codecs; one encoded payload per
 *   chunk. Used by cascaded TTS outputs.
 * - `pcm16`: raw little-endian 16-bit signed PCM. Default for realtime
 *   duplex paths (Gemini Live, LiveKit audio mixer).
 * - `pcm16-base64`: same bytes as `pcm16` but base64-encoded JSON-safe text.
 *   Used by provider-native realtime channels that tunnel audio through JSON
 *   events (OpenAI Realtime, xAI Grok Realtime).
 * - `g711-mulaw` / `g711-alaw`: 8kHz, 8-bit companded PCM. Used by SIP /
 *   Twilio / SmartPBX transports.
 */
export type VoiceAudioFormat =
  | "mp3"
  | "pcm16"
  | "wav"
  | "opus"
  | "pcm16-base64"
  | "g711-mulaw"
  | "g711-alaw";

// --- Conversation message role ---

export type VoiceRole = "user" | "assistant";

// --- Wire protocol: Client → Server ---

export type VoiceClientMessage =
  | { type: "hello"; protocol_version?: number }
  | { type: "start_call"; preferred_format?: VoiceAudioFormat }
  | { type: "end_call" }
  | { type: "start_of_speech" }
  | { type: "end_of_speech" }
  | { type: "interrupt" }
  | { type: "text_message"; text: string };

// --- Wire protocol: Server → Client ---

export type VoiceServerMessage =
  | { type: "welcome"; protocol_version: number }
  | { type: "status"; status: VoiceStatus }
  | { type: "audio_config"; format: VoiceAudioFormat; sampleRate?: number }
  | { type: "transcript"; role: VoiceRole; text: string }
  | { type: "transcript_start"; role: VoiceRole }
  | { type: "transcript_delta"; text: string }
  | { type: "transcript_end"; text: string }
  | { type: "transcript_interim"; text: string }
  | {
      type: "metrics";
      llm_ms: number;
      tts_ms: number;
      first_audio_ms: number;
      total_ms: number;
    }
  | { type: "error"; message: string };

// --- Pipeline metrics (structured form for consumers) ---

export interface VoicePipelineMetrics {
  llm_ms: number;
  tts_ms: number;
  first_audio_ms: number;
  total_ms: number;
}

// --- Transcript message (client-side enriched form) ---

export interface TranscriptMessage {
  role: VoiceRole;
  text: string;
  timestamp: number;
}

// --- Audio input ---

/**
 * Pluggable audio input source for a voice client.
 *
 * When provided via the client's options, the client delegates mic
 * capture to this object instead of using its built-in AudioWorklet.
 * The audio input is responsible for capturing audio and routing it to
 * the server (however it chooses — WebRTC, SFU, direct binary, etc.).
 *
 * It must call `onAudioLevel` with RMS values so the client can run
 * silence detection, interrupt detection, and update the audio level UI.
 */
export interface VoiceAudioInput {
  /** Start capturing audio. Called by the client on startCall(). */
  start(): Promise<void>;
  /** Stop capturing audio. Called by the client on endCall() or disconnect(). */
  stop(): void;
  /**
   * Set by the client before start(). The audio input must call this
   * with RMS audio level values on each frame so the client can run
   * silence detection, interrupt detection, and update the UI.
   */
  onAudioLevel: ((rms: number) => void) | null;

  /**
   * Set by the client before start(). If the audio input provides
   * raw PCM audio (16kHz mono 16-bit LE), call this callback and
   * the client will forward the data to the server via its transport.
   *
   * Contract:
   *   - REQUIRED to be invoked when audio reaches the server through the
   *     same channel as protocol messages (WebSocket binary frames, SFU
   *     same-socket path, or any transport where `supportsAudioInput`
   *     is true).
   *   - Optional — safe to leave unused — when audio reaches the server
   *     via an external path (separate SFU/WebRTC connection, native
   *     provider-realtime mic pipe). In that case the audio input exists
   *     only to drive level meters and voice-activity detection.
   */
  onAudioData?: ((pcm: ArrayBuffer) => void) | null;
}

// --- Voice transport ---

/**
 * Abstraction over the data channel between client and server.
 * The default implementation wraps PartySocket (WebSocket).
 * Implement this interface to use WebRTC, SFU, or other transports.
 */
export interface VoiceTransport {
  /** Send a JSON-serializable message to the server. */
  sendJSON(data: Record<string, unknown>): void;
  /** Send raw binary audio to the server. */
  sendBinary(data: ArrayBuffer): void;

  /** Open the connection. */
  connect(): void;
  /** Close the connection and release resources. */
  disconnect(): void;

  /** Whether the transport is currently connected and ready to send. */
  readonly connected: boolean;

  /**
   * Optional capability flag. `true` means the transport accepts raw audio
   * frames over the same connection as protocol messages (via
   * `VoiceAudioInput.onAudioData`). `false` or omitted means audio must
   * arrive via an external path (SFU, WebRTC, provider-native realtime).
   *
   * Transports self-declare; consumers branch on this to decide whether to
   * wire up same-socket audio forwarding.
   */
  readonly supportsAudioInput?: boolean;

  // --- Event callbacks (set by the client) ---
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error?: unknown) => void) | null;
  /** Called when a JSON string message arrives from the server. */
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null;
}
