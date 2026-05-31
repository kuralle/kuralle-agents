import { KuralleVoiceSession, type KuralleVoiceSessionOptions } from './KuralleVoiceSession.js';
import type { VoiceSession } from './VoiceSession.js';

/**
 * Cascaded-mode factory input — wraps `KuralleVoiceSessionOptions` and
 * returns the cascaded session that drives a LiveKit AgentSession via
 * STT → LLM-adapter → TTS.
 *
 * LiveKit voice is cascaded-only. For provider-native realtime (Gemini/OpenAI/xAI
 * RealtimeModel) use `@kuralle-agents/realtime-audio` (`VoiceEngine`).
 */
export interface CascadedVoiceSessionConfig {
  mode: 'cascaded';
  options: KuralleVoiceSessionOptions;
}

export type VoiceSessionFactoryConfig = CascadedVoiceSessionConfig;

export interface CreatedCascadedVoiceSession {
  mode: 'cascaded';
  session: KuralleVoiceSession;
}

export type CreatedVoiceSession = CreatedCascadedVoiceSession;

/**
 * Construct a cascaded `VoiceSession`. The returned object carries the
 * concrete cascaded `session` (which owns the AgentSession via
 * `start(transport)` / `say(...)`) alongside the `mode` tag.
 */
export async function createVoiceSession(
  config: VoiceSessionFactoryConfig,
): Promise<CreatedVoiceSession> {
  return { mode: 'cascaded', session: new KuralleVoiceSession(config.options) };
}

/**
 * Narrowing helper — returns the cascaded session's VoiceSession-conforming
 * face for callers that only need lifecycle management (id + close).
 */
export function asVoiceSession(created: CreatedVoiceSession): VoiceSession {
  return created.session;
}
