/// <reference types="bun-types" />
import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentSpan } from '../types/trace.js';
import type { TraceStore } from './TraceStore.js';

export type TraceStoreFactory = () => TraceStore | Promise<TraceStore>;

export function runTraceStoreContract(factory: TraceStoreFactory): void {
  describe('TraceStore contract', () => {
    let store: TraceStore;
    beforeEach(async () => { store = await factory(); });

    test('writes spans and reconstructs a JSON-safe trace', async () => {
      await store.putSpan(span('trace-a', 'session-a', 'root', 10, 'turn'));
      await store.putSpan(span('trace-a', 'session-a', 'tool', 11, 'tool'));
      const trace = await store.getTrace('trace-a');
      expect(trace?.spans.map((entry) => entry.spanId)).toEqual(['root', 'tool']);
      expect(trace?.sessionId).toBe('session-a');
      expect(() => JSON.stringify(trace)).not.toThrow();
    });

    test('returns null for a missing trace', async () => {
      expect(await store.getTrace('missing')).toBeNull();
    });

    test('lists newest traces for only the requested session and window', async () => {
      await store.putSpan(span('old', 'session-a', 'old-root', 10, 'turn'));
      await store.putSpan(span('new', 'session-a', 'new-root', 30, 'turn'));
      await store.putSpan(span('other', 'session-b', 'other-root', 40, 'turn'));
      const traces = await store.listTraces('session-a', { from: new Date(20), limit: 1 });
      expect(traces.map((trace) => trace.traceId)).toEqual(['new']);
    });

    test('upserts a span by trace and span id', async () => {
      const root = span('trace-a', 'session-a', 'root', 10, 'turn');
      await store.write(root);
      await store.putSpan({ ...root, endTime: 25 });
      expect((await store.getTrace('trace-a'))?.spans).toHaveLength(1);
      expect((await store.getTrace('trace-a'))?.endedAt).toBe(25);
    });
  });
}

function span(
  traceId: string,
  sessionId: string,
  spanId: string,
  startTime: number,
  kind: AgentSpan['kind'],
): AgentSpan {
  return {
    traceId,
    spanId,
    name: kind,
    kind,
    startTime,
    endTime: startTime + 5,
    status: 'ok',
    attributes: { sessionId },
  };
}
