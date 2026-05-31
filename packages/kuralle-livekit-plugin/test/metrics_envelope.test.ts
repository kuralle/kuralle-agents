import { describe, test, expect } from 'bun:test';
import { initializeLogger, voice } from '@livekit/agents';
import { attachMetricsBridge, emitKuralleMetric } from '../src/metrics/bridge.js';
import {
  VOICE_METRIC_VERSION,
  type VoiceMetric,
  type VoiceMetricsSink,
} from '../src/metrics/types.js';
import { createAgentSessionForMetrics } from './livekit_stubs.js';

initializeLogger({ pretty: false, level: 'warn' });

describe('voice metrics versioning envelope', () => {
  test('VOICE_METRIC_VERSION is 1', () => {
    expect(VOICE_METRIC_VERSION).toBe(1);
  });

  test('emitKuralleMetric tags the envelope with the current version', () => {
    const collected: VoiceMetric[] = [];
    const sink: VoiceMetricsSink = (m) => collected.push(m);
    emitKuralleMetric(sink, {
      type: 'aria_runtime_ttft',
      sessionId: 'sess-1',
      data: { ttftMs: 42 },
    });
    expect(collected.length).toBe(1);
    expect(collected[0]!.version).toBe(VOICE_METRIC_VERSION);
    expect(collected[0]!.type).toBe('aria_runtime_ttft');
    expect(collected[0]!.sessionId).toBe('sess-1');
  });

  test('attachMetricsBridge tags forwarded LiveKit metrics with the version', () => {
    const session = createAgentSessionForMetrics();
    const collected: VoiceMetric[] = [];
    const detach = attachMetricsBridge(session, 'sess-bridge', (m) => collected.push(m));

    session.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: voice.AgentSessionEventTypes.MetricsCollected,
      createdAt: 999,
      metrics: { type: 'llm_metrics', timestamp: 999, ttftMs: 12, label: 'test', requestId: 'r1', durationMs: 100, cancelled: false, completionTokens: 10, promptTokens: 20, promptCachedTokens: 0, totalTokens: 30, tokensPerSecond: 100 },
    });

    expect(collected.length).toBe(1);
    expect(collected[0]!.version).toBe(VOICE_METRIC_VERSION);
    expect(collected[0]!.type).toBe('llm');
    expect(collected[0]!.timestamp).toBe(999);
    detach();
  });

  test('detach removes the listener — no further events forwarded', () => {
    const session = createAgentSessionForMetrics();
    const collected: VoiceMetric[] = [];
    const detach = attachMetricsBridge(session, 'sess', (m) => collected.push(m));
    detach();
    session.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: voice.AgentSessionEventTypes.MetricsCollected,
      createdAt: 1,
      metrics: { type: 'llm_metrics', timestamp: 1, ttftMs: 10, label: 'test', requestId: 'r1', durationMs: 100, cancelled: false, completionTokens: 10, promptTokens: 20, promptCachedTokens: 0, totalTokens: 30, tokensPerSecond: 100 },
    });
    expect(collected.length).toBe(0);
  });
});
