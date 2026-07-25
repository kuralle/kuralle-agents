import { describe, expect, test } from 'bun:test';
import { MemoryTraceStore } from '../../src/tracing/MemoryTraceStore.js';
import { runTraceStoreContract } from '../../src/tracing/testing.js';
import type { AgentSpan } from '../../src/types/trace.js';
import { TraceRecorder } from '../../src/runtime/TraceRecorder.js';

runTraceStoreContract(() => new MemoryTraceStore());

describe('TraceRecorder sinks', () => {
  test('emits each completed span exactly once with a per-run trace id', () => {
    const spans: AgentSpan[] = [];
    const recorder = new TraceRecorder({ sessionId: 'session-a', onSpan: (span) => spans.push(span) });
    recorder.record({ channel: 'internal', type: 'flow-enter', payload: { flow: 'checkout' } });
    recorder.record({ channel: 'internal', type: 'flow-end', payload: { flow: 'checkout', reason: 'completed' } });
    recorder.record({ channel: 'client', type: 'done', payload: { sessionId: 'session-a' } });
    expect(spans.map((span) => span.kind)).toEqual(['flow', 'turn']);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(spans[0]?.traceId).not.toBe('session-a');
  });
});
