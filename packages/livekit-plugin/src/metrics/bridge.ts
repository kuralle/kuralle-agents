/**
 * Bridges LiveKit's AgentSession.MetricsCollected event to Kuralle's
 * VoiceMetricsSink callback.
 *
 * This module subscribes to the AgentSession event emitter, normalizes
 * each LiveKit metric into a VoiceMetric, and calls the sink. All calls
 * are synchronous and fire-and-forget.
 *
 * The bridge also provides a helper for emitting Kuralle-originated
 * metrics (runtime TTFT, runtime duration) through the same sink.
 */

import { voice, metrics } from '@livekit/agents';
import {
  VOICE_METRIC_VERSION,
  type VoiceMetric,
  type VoiceMetricsSink,
  type VoiceMetricType,
} from './types.js';

type AgentMetrics = metrics.AgentMetrics;

/**
 * Map LiveKit's metric type discriminator to our VoiceMetricType.
 */
function mapMetricType(lkType: string): VoiceMetricType | null {
  switch (lkType) {
    case 'llm_metrics': return 'llm';
    case 'tts_metrics': return 'tts';
    case 'stt_metrics': return 'stt';
    case 'vad_metrics': return 'vad';
    case 'eou_metrics': return 'eou';
    default: return null;
  }
}

/**
 * Extract speechId from a LiveKit metric if present.
 * LiveKit attaches speechId to LLM, TTS, and EOU metrics via
 * AgentActivity context variable injection.
 */
function extractSpeechId(metrics: Record<string, unknown>): string | undefined {
  const id = metrics.speechId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Safely invoke the sink. Catches synchronous errors to prevent
 * a misbehaving consumer from crashing the voice pipeline.
 */
function safeSinkCall(sink: VoiceMetricsSink, metric: VoiceMetric): void {
  try {
    sink(metric);
  } catch (err) {
    console.error(
      '[voice-metrics] Metrics sink threw:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Subscribe to LiveKit AgentSession metrics and forward to the sink.
 *
 * Returns a detach function that removes the event listener.
 *
 * @param session - The LiveKit AgentSession to subscribe to.
 * @param sessionId - The Kuralle session/transport ID for attribution.
 * @param sink - The consumer callback. Called synchronously, fire-and-forget.
 */
export function attachMetricsBridge(
  session: voice.AgentSession,
  sessionId: string,
  sink: VoiceMetricsSink,
): () => void {
  const handler = (ev: { metrics: AgentMetrics }) => {
    const lkMetrics = ev.metrics as Record<string, unknown>;
    const type = mapMetricType(lkMetrics.type as string);
    if (!type) return;

    safeSinkCall(sink, {
      version: VOICE_METRIC_VERSION,
      type,
      sessionId,
      speechId: extractSpeechId(lkMetrics),
      timestamp: typeof lkMetrics.timestamp === 'number' ? lkMetrics.timestamp : Date.now(),
      data: lkMetrics,
    });
  };

  session.on(voice.AgentSessionEventTypes.MetricsCollected, handler);

  return () => {
    session.off(voice.AgentSessionEventTypes.MetricsCollected, handler);
  };
}

/**
 * Emit an Kuralle-originated metric through the sink.
 *
 * Use this for metrics measured inside KuralleRuntimeLLMStream.run()
 * that are not part of LiveKit's metric pipeline.
 */
export function emitKuralleMetric(
  sink: VoiceMetricsSink,
  metric: {
    type: 'aria_runtime_ttft' | 'aria_runtime_end';
    sessionId: string;
    data: Record<string, unknown>;
  },
): void {
  safeSinkCall(sink, {
    version: VOICE_METRIC_VERSION,
    type: metric.type,
    sessionId: metric.sessionId,
    timestamp: Date.now(),
    data: metric.data,
  });
}
