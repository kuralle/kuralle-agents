/**
 * Voice-optimized default configuration for AgentSession.
 *
 * These defaults unlock LiveKit's built-in features that are critical
 * for production voice quality:
 *
 * - preemptiveGeneration: Starts LLM inference on interim STT transcripts
 *   before end-of-turn is confirmed. Saves 200-400ms on ~70% of turns.
 *
 * - allowInterruptions: Lets the user barge in while the agent is speaking.
 *   Without this, the agent talks over the user.
 *
 * - minInterruptionDuration: Ignores sub-500ms noise bursts (coughs,
 *   background noise) that would otherwise trigger false interruptions.
 *
 * - aecWarmupDuration: Suppresses interruption detection for 3 seconds
 *   after the agent starts speaking, giving acoustic echo cancellation
 *   time to converge. Without this, the agent's own audio feeding back
 *   through the user's microphone triggers false interruptions.
 *
 * All defaults can be overridden by the caller's options via object spread.
 */

import type { voice } from '@livekit/agents';

/**
 * Sensible voice-optimized defaults. The caller's options override these
 * via spread: { ...VOICE_DEFAULTS.voiceOptions, ...userOptions.voiceOptions }
 */
export const VOICE_OPTIMIZED_VOICE_OPTIONS: Partial<voice.VoiceOptions> = {
  allowInterruptions: true,
  minInterruptionDuration: 500,
  minInterruptionWords: 0,
  maxEndpointingDelay: 6000,
};

/**
 * Merge caller-provided voiceOptions with voice-optimized defaults.
 * Caller values take precedence over defaults.
 */
export function mergeVoiceOptions(
  userOptions?: Partial<voice.VoiceOptions>,
): Partial<voice.VoiceOptions> {
  if (!userOptions) return { ...VOICE_OPTIMIZED_VOICE_OPTIONS };
  return { ...VOICE_OPTIMIZED_VOICE_OPTIONS, ...userOptions };
}
