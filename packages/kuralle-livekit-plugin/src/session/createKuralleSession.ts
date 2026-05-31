import { voice, stt, tts, type VAD } from '@livekit/agents';
import type { HarnessConfig, Runtime } from '@kuralle-agents/core';
import { KuralleVoiceSession } from './KuralleVoiceSession.js';

export interface CreateKuralleSessionOptions {
  runtime: Runtime | HarnessConfig;
  stt: stt.STT;
  tts: tts.TTS;
  vad?: VAD;
  turnDetection?: voice.AgentSessionOptions['turnDetection'];
  voiceOptions?: Partial<voice.VoiceOptions>;
  greeting?: string | null;
  prompt?: string;
  onKuralleHandoff?: (from: string, to: string) => void | Promise<void>;
}

/**
 * Factory function to create an Kuralle voice session for transport-backed use.
 */
export function createKuralleSession(
  opts: CreateKuralleSessionOptions,
): KuralleVoiceSession {
  return new KuralleVoiceSession(opts);
}
