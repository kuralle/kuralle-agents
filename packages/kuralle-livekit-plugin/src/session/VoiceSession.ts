/**
 * Common surface shared by every Kuralle voice-session host.
 *
 * One concrete implementation lives in this package: `KuralleVoiceSession`
 * (cascaded STT → LLM → TTS path, drives a LiveKit AgentSession). For
 * provider-native realtime (Gemini/OpenAI/xAI RealtimeModel) the host lives
 * in `@kuralle-agents/realtime-audio` (`VoiceEngine`), not here.
 *
 * What this interface captures is the genuinely common part: identity +
 * lifecycle terminus. Callers that only need a session-scoped handle
 * (observability sinks, retain/release patterns, factory return shape) hold
 * a `VoiceSession`; callers that need cascaded affordances (`say`, …) hold
 * the concrete `KuralleVoiceSession` instead.
 */
export interface VoiceSession {
  /** Stable identifier — correlation key for metrics, logs, persistence. */
  readonly sessionId: string;

  /**
   * Terminus of the voice session's life. Idempotent: implementations are
   * required to tolerate repeated calls and concurrent in-flight close from
   * a different caller. The cascaded implementation closes the underlying
   * AgentSession, leaving the implementing object in an unusable state.
   */
  close(): Promise<void>;
}

/**
 * Tagged config for the `createVoiceSession` factory. Concrete types live
 * with the implementations they construct so the factory stays trivial.
 */
export type VoiceSessionMode = 'cascaded';
