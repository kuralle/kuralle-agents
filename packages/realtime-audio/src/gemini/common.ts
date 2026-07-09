/**
 * Shared constants for the Gemini Live `RealtimeAudioClient` implementations.
 *
 * Both `node/GeminiLiveSession.ts` (uses the `@google/genai` SDK) and
 * `cloudflare/gemini-live.ts` (raw fetch+Upgrade WS) declare an identical
 * `RealtimeCapabilities` object. Hosted here so the capability surface is
 * defined exactly once — drift between Node and CF advertised capabilities
 * has been a source of confusion in past audits.
 *
 * Wire-level frame builders / handle tracking / generation tracking are NOT
 * shared: the SDK abstracts those on Node, and the CF path drives them
 * directly. They live with their respective transport surfaces.
 */

import type { RealtimeCapabilities } from '@kuralle-agents/core/realtime';

export const GEMINI_CAPABILITIES: RealtimeCapabilities = {
  turnDetection: true,
  userTranscription: true,
  messageTruncation: false,
  autoToolReplyGeneration: true,
  audioOutput: true,
  manualFunctionCalls: true,
  midSessionChatCtxUpdate: false,
  midSessionInstructionsUpdate: false,
  midSessionToolsUpdate: false,
  reconnectStrategy: 'handle',
};
