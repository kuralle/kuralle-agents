import type { RealtimeAudioClient } from '@kuralle-agents/core/realtime';
import type { VoiceAgentConfig, GeminiConfig } from './types.js';
import type { OpenAIRealtimeClientConfig } from './openai/OpenAIRealtimeClient.js';
import { GeminiLiveSession } from './node/GeminiLiveSession.js';
import { OpenAIRealtimeClient } from './openai/OpenAIRealtimeClient.js';

/**
 * Create a Gemini model client factory for VoiceEngine.
 *
 * Usage:
 * ```typescript
 * const engine = new VoiceEngine({
 *   ...config,
 *   createModelClient: createGeminiClientFactory({ apiKey: '...' }),
 * });
 * ```
 */
export function createGeminiClientFactory(
  gemini: GeminiConfig,
): (agent: VoiceAgentConfig) => RealtimeAudioClient {
  return (agent: VoiceAgentConfig) => {
    return new GeminiLiveSession({
      gemini,
      agent,
      onEvent: () => {}, // Events go through the on() interface
    });
  };
}

/**
 * Create an OpenAI Realtime model client factory for VoiceEngine.
 *
 * Usage:
 * ```typescript
 * const engine = new VoiceEngine({
 *   ...config,
 *   createModelClient: createOpenAIClientFactory({ apiKey: '...' }),
 * });
 * ```
 *
 * This plugs OpenAI Realtime into the same VoiceEngine stack as Gemini —
 * same hooks, persistence, extraction, and memory ingestion.
 */
export function createOpenAIClientFactory(
  openai: OpenAIRealtimeClientConfig,
): (agent: VoiceAgentConfig) => RealtimeAudioClient {
  return (_agent: VoiceAgentConfig) => {
    return new OpenAIRealtimeClient(openai);
  };
}
