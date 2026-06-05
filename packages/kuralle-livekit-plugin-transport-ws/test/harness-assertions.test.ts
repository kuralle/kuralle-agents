import { describe, expect, it } from 'bun:test';
import { assertFirstAudioBeforeRuntimeEnd } from './e2e/harness/assertions.js';
import type { RuntimeMetricEvent, TurnLatency } from './e2e/harness/trace_collector.js';
import { TraceCollector } from './e2e/harness/trace_collector.js';

interface AssertionTraceFixture {
  turnLatencies: TurnLatency[];
  runtimeMetrics: RuntimeMetricEvent[];
}

function makeTrace(fixture: AssertionTraceFixture): TraceCollector {
  const trace = new TraceCollector();
  trace.turnLatencies = fixture.turnLatencies;
  trace.runtimeMetrics = fixture.runtimeMetrics;
  return trace;
}

function textTurnFixture(overrides: {
  startedAt?: number;
  firstAudioAt?: number | null;
  includeTtft?: boolean;
  ttftAt?: number;
  endAt?: number;
  ttftMs?: number;
}): AssertionTraceFixture {
  const startedAt = overrides.startedAt ?? 1000;
  const firstAudioAt = overrides.firstAudioAt ?? startedAt + 200;
  const endAt = overrides.endAt ?? startedAt + 500;

  const metrics: RuntimeMetricEvent[] = [];
  if (overrides.includeTtft !== false) {
    metrics.push({
      type: 'aria_runtime_ttft',
      timestamp: overrides.ttftAt ?? startedAt + 100,
      data: { ttftMs: overrides.ttftMs ?? 100 },
    });
  }
  metrics.push({
    type: 'aria_runtime_end',
    timestamp: endAt,
    data: { durationMs: 400, chunks: 3 },
  });

  return {
    turnLatencies: [
      {
        turnIndex: 0,
        label: 'greeting',
        startedAt: 0,
        firstTextAt: 50,
        firstAudioAt: 80,
        turnSettledAt: 900,
        timeToFirstTextMs: 50,
        timeToFirstAudioMs: 80,
        totalTurnMs: 900,
      },
      {
        turnIndex: 1,
        label: 'text_turn',
        startedAt,
        firstTextAt: startedAt + 50,
        firstAudioAt: firstAudioAt,
        turnSettledAt: endAt + 100,
        timeToFirstTextMs: 50,
        timeToFirstAudioMs: firstAudioAt !== null ? firstAudioAt - startedAt : null,
        totalTurnMs: endAt + 100 - startedAt,
      },
    ],
    runtimeMetrics: metrics,
  };
}

describe('assertFirstAudioBeforeRuntimeEnd', () => {
  it('passes when ttft, correlated audio, and runtime end are ordered for the turn', () => {
    const trace = makeTrace(textTurnFixture({}));
    const result = assertFirstAudioBeforeRuntimeEnd(trace, 'text_turn');

    expect(result.pass).toBe(true);
    expect(result.ttftMs).toBe(100);
    expect(result.detail).toContain('ttft→audio→end ordering ok');
  });

  it('fails when only unrelated audio exists with no aria_runtime_ttft (regression)', () => {
    const trace = makeTrace(
      textTurnFixture({
        firstAudioAt: 1200,
        includeTtft: false,
      }),
    );

    const result = assertFirstAudioBeforeRuntimeEnd(trace, 'text_turn');

    expect(result.pass).toBe(false);
    expect(result.detail).toContain('No aria_runtime_ttft');
    expect(result.ttftMs).toBeNull();
  });

  it('fails when first audio arrives after aria_runtime_end', () => {
    const trace = makeTrace(
      textTurnFixture({
        firstAudioAt: 1600,
        endAt: 1500,
      }),
    );

    const result = assertFirstAudioBeforeRuntimeEnd(trace, 'text_turn');

    expect(result.pass).toBe(false);
    expect(result.detail).toContain('not before aria_runtime_end');
  });
});
