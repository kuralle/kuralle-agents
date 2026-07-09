/**
 * @kuralle-agents/cf-agent/voice — realtime voice mixin + agent base for
 * Cloudflare Durable Objects. Pairs with any
 * {@link RealtimeAudioClient} (v2) implementation — Gemini Live,
 * OpenAI Realtime, xAI Grok, etc.
 *
 * For the cascaded (STT → LLM → TTS) variant, see the sibling
 * `KuralleCascadedVoiceAgent` export.
 */

export { withRealtimeVoice } from "./withRealtimeVoice.js";
export type {
  RealtimeVoiceOptions,
  RealtimeVoiceMixinMembers,
} from "./withRealtimeVoice.js";
export { KuralleRealtimeVoiceAgent } from "./RealtimeVoiceAgent.js";
export { AudioConnectionManager, sendVoiceJSON } from "./AudioConnectionManager.js";
