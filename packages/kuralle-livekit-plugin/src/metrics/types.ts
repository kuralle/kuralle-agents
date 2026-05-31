/**
 * Voice pipeline metrics types.
 *
 * These types define the contract between the voice pipeline and any
 * metrics consumer. The pipeline emits VoiceMetric objects via a
 * synchronous callback (VoiceMetricsSink). The consumer decides what
 * to do with them: log, batch, forward to an analytics backend, or
 * discard.
 *
 * Two categories of metrics flow through this interface:
 *
 * 1. LiveKit-originated metrics -- emitted by AgentSession's internal
 *    STT, TTS, LLM, VAD, and EOU providers. These arrive via the
 *    AgentSessionEventTypes.MetricsCollected event and are normalized
 *    into VoiceMetric shape.
 *
 * 2. Kuralle-originated metrics -- measured inside
 *    KuralleRuntimeLLMStream.run(), covering the Kuralle Runtime pipeline
 *    stages that execute before the first text-delta reaches LiveKit.
 */

/**
 * Discriminated union of metric categories.
 *
 * LiveKit-originated:
 *   - 'stt'   : Speech-to-text processing (duration, audio duration, streaming flag).
 *   - 'tts'   : Text-to-speech synthesis (TTFB, duration, character count).
 *   - 'llm'   : LLM inference (TTFT, duration, token counts, tokens/second).
 *   - 'vad'   : Voice activity detection (idle time, inference count).
 *   - 'eou'   : End-of-utterance detection (delay from silence to turn commit).
 *
 * Kuralle-originated:
 *   - 'aria_runtime_ttft' : Time from runtime.stream() call to first text-delta.
 *   - 'aria_runtime_end'  : Total runtime.stream() duration and chunk count.
 */
export type VoiceMetricType =
  | 'stt'
  | 'tts'
  | 'llm'
  | 'vad'
  | 'eou'
  | 'aria_runtime_ttft'
  | 'aria_runtime_end';

/**
 * Current voice-metrics envelope version. Bump on backwards-incompatible
 * shape changes so consumers can negotiate forward-compat.
 *
 * Version-bump rule: any change that removes a field, narrows the type
 * of an existing field, or alters semantics is a bump. Adding new
 * optional fields or new `type` discriminants is NOT a bump (consumers
 * should ignore unknown discriminants).
 */
export const VOICE_METRIC_VERSION = 1 as const;

/**
 * A single voice pipeline metric event.
 *
 * Carries an explicit `version` so sinks can branch on shape changes
 * over time (per the RFC-architecture-refactor metrics-versioning
 * envelope). The `data` field is intentionally typed as
 * Record<string, unknown> because LiveKit's metric shapes vary by type
 * (LLMMetrics has ttftMs + promptTokens, TTSMetrics has ttfbMs +
 * charactersCount, etc.). The consumer is expected to inspect `type`
 * and cast `data` accordingly, or treat it as opaque key-value pairs
 * for storage.
 */
export interface VoiceMetric {
  /** Envelope version. Always equals `VOICE_METRIC_VERSION` at emit time. */
  version: typeof VOICE_METRIC_VERSION;

  /** Metric category. Used for routing and filtering. */
  type: VoiceMetricType;

  /** Session identifier. Matches the transport adapter ID or LiveKit room session ID. */
  sessionId: string;

  /**
   * Speech handle ID from LiveKit's AgentActivity. Links metrics
   * to a specific agent utterance. Present on LLM, TTS, and EOU
   * metrics. Absent on VAD and Kuralle-originated metrics.
   */
  speechId?: string;

  /** Unix timestamp in milliseconds when this metric was recorded. */
  timestamp: number;

  /**
   * Metric payload. Shape depends on `type`:
   *
   * - 'llm': { ttftMs, durationMs, promptTokens, completionTokens, tokensPerSecond, cancelled, label, ... }
   * - 'tts': { ttfbMs, durationMs, audioDurationMs, charactersCount, cancelled, label, ... }
   * - 'stt': { durationMs, audioDurationMs, streamed, label, ... }
   * - 'vad': { idleTimeMs, inferenceDurationTotalMs, inferenceCount, label }
   * - 'eou': { endOfUtteranceDelayMs, transcriptionDelayMs, lastSpeakingTimeMs }
   * - 'aria_runtime_ttft': { ttftMs }
   * - 'aria_runtime_end': { durationMs, chunks }
   */
  data: Record<string, unknown>;
}

/**
 * Callback type for consuming voice metrics.
 *
 * Called synchronously and fire-and-forget. The pipeline never awaits
 * the return value. If the sink is async, the consumer owns error
 * handling. If the sink throws synchronously, the error is caught and
 * logged to prevent pipeline disruption.
 *
 * Design rationale: a single callback is simpler than EventEmitter,
 * has zero allocation overhead per event, and composes trivially
 * (wrap in a function that fans out to multiple destinations).
 */
export type VoiceMetricsSink = (metric: VoiceMetric) => void;
