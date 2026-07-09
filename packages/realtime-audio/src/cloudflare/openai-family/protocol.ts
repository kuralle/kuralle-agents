/**
 * Wire-protocol helpers for the OpenAI Realtime family (OpenAI + Azure + xAI).
 *
 * All three providers speak the same JSON-over-WebSocket protocol. This file
 * owns the event-name canonicalization, frame builders, and capability
 * constants. Pure, side-effect-free — unit-testable without a live socket.
 *
 * See cloudflare-research/openai-realtime-on-cloudflare/prior-art/ for citations.
 */

import type {
  RealtimeCapabilities,
  RealtimeSessionConfig,
  RealtimeToolResponse,
} from '@kuralle-agents/core/realtime';

/** Package version used in the WS subprotocol list for telemetry. */
export const REALTIME_AUDIO_VERSION = '0.10.0';

/**
 * Canonical event names we emit downstream. OpenAI Realtime uses dual names
 * during the GA migration (e.g. `response.text.delta` Beta → `response.output_text.delta`
 * GA). Consumers read canonical; the dispatcher normalizes at ingress.
 */
export type CanonicalEvent =
  | 'session.created'
  | 'session.updated'
  | 'response.output_audio.delta'
  | 'response.output_audio.done'
  | 'response.output_audio_transcript.delta'
  | 'response.output_audio_transcript.done'
  | 'response.output_text.delta'
  | 'response.output_text.done'
  | 'response.output_item.added'
  | 'response.output_item.done'
  | 'response.content_part.added'
  | 'response.content_part.done'
  | 'response.created'
  | 'response.done'
  | 'conversation.item.added'
  | 'conversation.item.input_audio_transcription.completed'
  | 'conversation.item.input_audio_transcription.failed'
  | 'input_audio_buffer.speech_started'
  | 'input_audio_buffer.speech_stopped'
  | 'input_audio_buffer.committed'
  | 'rate_limits.updated'
  | 'error';

/** Beta → GA rename table. Dispatcher looks up raw name; missing = already canonical. */
const BETA_TO_GA: Record<string, CanonicalEvent> = {
  'response.text.delta': 'response.output_text.delta',
  'response.text.done': 'response.output_text.done',
  'response.audio.delta': 'response.output_audio.delta',
  'response.audio.done': 'response.output_audio.done',
  'response.audio_transcript.delta': 'response.output_audio_transcript.delta',
  'response.audio_transcript.done': 'response.output_audio_transcript.done',
  'conversation.item.created': 'conversation.item.added',
};

export function canonicalizeEventName(raw: string): string {
  return BETA_TO_GA[raw] ?? raw;
}

// ─── Capabilities ───────────────────────────────────────────────────────────

/**
 * Shared capability shape for the whole OpenAI family. Mid-session updates
 * are the big upside over Gemini — OpenAI accepts `session.update` at any time
 * to change instructions / voice / tool set.
 */
export const OPENAI_FAMILY_CAPABILITIES: RealtimeCapabilities = {
  turnDetection: true,
  userTranscription: true,
  messageTruncation: true,
  autoToolReplyGeneration: false,
  audioOutput: true,
  manualFunctionCalls: true,
  midSessionChatCtxUpdate: true,
  midSessionInstructionsUpdate: true,
  midSessionToolsUpdate: true,
  perResponseToolChoice: true,
  reconnectStrategy: 'replay',
};

// ─── Provider profile (composition, not inheritance) ────────────────────────

/**
 * Full turn_detection shape accepted by OpenAI Realtime session.update.
 * Verified against `@livekit/agents-plugin-openai` api_proto.ts. Sending only
 * `{ type: 'semantic_vad' }` with no other fields produces a default
 * `eagerness: 'auto'` which waits indefinitely for "complete turn" — we need
 * `eagerness: 'medium'` for predictable response-after-silence behaviour.
 */
export type TurnDetection =
  | {
      type: 'semantic_vad';
      eagerness?: 'auto' | 'low' | 'medium' | 'high';
      create_response?: boolean;
      interrupt_response?: boolean;
    }
  | {
      type: 'server_vad';
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
      create_response?: boolean;
      interrupt_response?: boolean;
    }
  | { type: null };

export interface ProviderProfile {
  provider: 'openai' | 'azure-openai' | 'xai-grok';
  modelDefault: string;
  voiceDefault: string;
  /**
   * Full turn_detection object (not just a type string). Matches the defaults
   * shipped by `@livekit/agents-plugin-openai` for each provider so behaviour
   * on Workers matches behaviour on LiveKit/Node.
   */
  turnDetectionDefault: TurnDetection;
  buildUrl(model: string): string;
  buildSubprotocols(apiKey: string): string[];
}

const SUBPROTOCOL_TAG = `kuralle-realtime-audio.${REALTIME_AUDIO_VERSION}`;

/**
 * CF Workers `fetch()+Upgrade` cannot pass custom HTTP headers on the WS
 * handshake. OpenAI's own `@openai/agents-realtime` ships the
 * `['realtime', 'openai-insecure-api-key.<KEY>', '<SDK-TAG>']` subprotocol
 * form for workerd. We use the same shape for all three providers — xAI and
 * Azure accept it because their endpoints are OpenAI-protocol-compatible.
 */
function openaiStyleSubprotocols(apiKey: string): string[] {
  return ['realtime', `openai-insecure-api-key.${apiKey}`, SUBPROTOCOL_TAG];
}

// Defaults below match `@livekit/agents-plugin-openai`:
//   OpenAI:      realtime_model.ts:95-100  (semantic_vad, eagerness medium, create/interrupt true)
//   Azure:       realtime_model.ts:111-117 (server_vad with thresholds)
//   xAI:         plugins/xai/src/realtime/realtime_model.ts:13-20 (server_vad)
export const OPENAI_PROFILE: ProviderProfile = {
  provider: 'openai',
  modelDefault: 'gpt-realtime',
  voiceDefault: 'marin',
  turnDetectionDefault: {
    type: 'semantic_vad',
    eagerness: 'medium',
    create_response: true,
    interrupt_response: true,
  },
  buildUrl: (model) => `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
  buildSubprotocols: openaiStyleSubprotocols,
};

export const XAI_PROFILE: ProviderProfile = {
  provider: 'xai-grok',
  modelDefault: 'grok-4-1-fast-non-reasoning',
  voiceDefault: 'ara',
  turnDetectionDefault: {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 200,
    create_response: true,
    interrupt_response: true,
  },
  buildUrl: (model) => `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`,
  buildSubprotocols: openaiStyleSubprotocols,
};

export interface AzureProfileOpts {
  endpoint: string; // e.g. "https://my-resource.openai.azure.com"
  apiVersion: string; // e.g. "2025-04-01-preview"
  deployment: string;
}

export function azureProfile(opts: AzureProfileOpts): ProviderProfile {
  // Azure uses wss:// direct — the client passes subprotocols via
  // `new WebSocket()`. URL is declared with wss:// for parity with OpenAI / xAI.
  const base = opts.endpoint.replace(/\/$/, '').replace(/^https?:\/\//, 'wss://');
  return {
    provider: 'azure-openai',
    modelDefault: opts.deployment,
    voiceDefault: 'marin',
    // Azure's realtime endpoint historically recommends server_vad (per LiveKit
    // `AZURE_DEFAULT_TURN_DETECTION` at realtime_model.ts:111-117).
    turnDetectionDefault: {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 200,
      create_response: true,
    },
    buildUrl: () =>
      `${base}/openai/realtime?api-version=${encodeURIComponent(opts.apiVersion)}` +
      `&deployment=${encodeURIComponent(opts.deployment)}`,
    buildSubprotocols: openaiStyleSubprotocols,
  };
}

// ─── Frame builders ─────────────────────────────────────────────────────────

export interface SessionUpdateOpts {
  model: string;
  voice: string;
  turnDetection: TurnDetection;
  inputAudioRate: number;
  outputAudioRate: number;
  systemInstruction?: string;
  tools?: RealtimeSessionConfig['tools'];
}

/**
 * Build the `session.update` frame sent as the first message after WS open.
 * Shape pinned to the GA schema (`session.type: 'realtime'`, `output_modalities`,
 * `audio.{input,output}.format.{type,rate}`). Compatible with Beta servers.
 */
export function buildSessionUpdate(opts: SessionUpdateOpts): Record<string, unknown> {
  const session: Record<string, unknown> = {
    type: 'realtime',
    model: opts.model,
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: opts.inputAudioRate },
        transcription: { model: 'gpt-4o-mini-transcribe' },
        // Send the full turn_detection object, not just `{ type }`. Without
        // explicit `create_response` / `interrupt_response` / `eagerness`,
        // OpenAI defaults to `eagerness: 'auto'` which waits indefinitely for
        // a "semantically complete" utterance and the buffer never commits.
        turn_detection: opts.turnDetection,
      },
      output: {
        format: { type: 'audio/pcm', rate: opts.outputAudioRate },
        voice: opts.voice,
      },
    },
  };
  if (opts.systemInstruction) session.instructions = opts.systemInstruction;
  if (opts.tools && opts.tools.length) {
    session.tools = opts.tools.map((t) => ({
      type: 'function',
      name: (t as { name: string }).name,
      description: (t as { description?: string }).description ?? '',
      parameters: (t as { parameters?: unknown }).parameters ?? { type: 'object', properties: {} },
    }));
  }
  return { type: 'session.update', session };
}

/** Frame sent for each PCM16 chunk streamed from the client. */
export function buildAudioAppend(pcm16Base64: string): Record<string, unknown> {
  return { type: 'input_audio_buffer.append', audio: pcm16Base64 };
}

/**
 * Build the two-frame sequence for completing a tool call. Returns them as an
 * array so the caller can enqueue atomically — OpenAI requires the
 * `function_call_output` item to arrive BEFORE the `response.create`.
 */
export function buildToolResponseFrames(
  responses: RealtimeToolResponse[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of responses) {
    out.push({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: r.id,
        output: JSON.stringify(r.output),
      },
    });
  }
  out.push({ type: 'response.create' });
  return out;
}

/** Chain helper — replay emits `conversation.item.create` with `previous_item_id`. */
export function buildItemCreate(
  item: Record<string, unknown>,
  previousItemId: string | null,
): Record<string, unknown> {
  const frame: Record<string, unknown> = { type: 'conversation.item.create', item };
  if (previousItemId) frame.previous_item_id = previousItemId;
  return frame;
}

export function buildResponseCancel(): Record<string, unknown> {
  return { type: 'response.cancel' };
}

export function buildConversationItemTruncate(
  itemId: string,
  contentIndex: number,
  audioEndMs: number,
): Record<string, unknown> {
  return {
    type: 'conversation.item.truncate',
    item_id: itemId,
    content_index: contentIndex,
    audio_end_ms: audioEndMs,
  };
}
