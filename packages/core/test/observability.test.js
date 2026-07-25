import test from 'node:test';
import assert from 'node:assert/strict';

import { TraceRecorder } from '../dist/runtime/TraceRecorder.js';
import { MemoryTraceStore } from '../dist/tracing/MemoryTraceStore.js';
import { OtelTraceSink } from '../dist/tracing/OtelTraceSink.js';

test('tracing: sink receives completed tool and turn spans', () => {
  const spans = [];
  const recorder = new TraceRecorder({
    sessionId: 'trace-sink',
    agentId: 'support',
    onSpan: (span) => spans.push(span),
  });
  recorder.record({
    channel: 'internal',
    type: 'tool-call',
    payload: { toolName: 'lookup', toolCallId: 'call-1', args: { q: 'status' } },
  });
  recorder.record({
    channel: 'internal',
    type: 'tool-result',
    payload: { toolName: 'lookup', toolCallId: 'call-1', result: { ok: true } },
  });
  recorder.record({ channel: 'client', type: 'done', payload: { sessionId: 'trace-sink' } });

  assert.deepEqual(spans.map((span) => span.kind), ['tool', 'turn']);
  assert.equal(spans[0].attributes.agentId, 'support');
  assert.equal(spans[1].attributes.agentId, 'support');
});

test('tracing: handoff changes child attribution without rewriting the turn', () => {
  const recorder = new TraceRecorder({ sessionId: 'trace-handoff', agentId: 'triage' });
  recorder.record({
    channel: 'internal',
    type: 'handoff',
    payload: { targetAgent: 'billing', reason: 'invoice' },
  });
  recorder.record({
    channel: 'internal',
    type: 'node-enter',
    payload: { nodeName: 'invoice' },
  });
  recorder.record({ channel: 'internal', type: 'node-exit', payload: { nodeName: 'invoice' } });
  recorder.record({ channel: 'client', type: 'done', payload: { sessionId: 'trace-handoff' } });

  const trace = recorder.finish({ text: '', toolResults: [] });
  assert.equal(trace.spans.find((span) => span.kind === 'turn').attributes.agentId, 'triage');
  assert.equal(trace.spans.find((span) => span.kind === 'node').attributes.agentId, 'billing');
});

test('tracing: MemoryTraceStore reconstructs a pushed trace', async () => {
  const store = new MemoryTraceStore();
  await store.write({
    traceId: '00112233445566778899aabbccddeeff',
    spanId: '0011223344556677',
    name: 'turn',
    kind: 'turn',
    startTime: 1000,
    endTime: 1010,
    status: 'ok',
    attributes: { sessionId: 'stored-session', agentId: 'support', output: 'Done.' },
  });

  const traces = await store.listTraces('stored-session');
  assert.equal(traces.length, 1);
  assert.equal(traces[0].answer, 'Done.');
  assert.equal(traces[0].spans[0].attributes.agentId, 'support');
});

test('tracing: OtelTraceSink posts agent attribution to the OTLP endpoint', async () => {
  const requests = [];
  const sink = new OtelTraceSink({
    endpoint: 'https://otel.test',
    fetch: async (input, init) => {
      requests.push({ input: String(input), init });
      return new Response(null, { status: 200 });
    },
  });
  sink.write({
    traceId: '00112233445566778899aabbccddeeff',
    spanId: '0011223344556677',
    name: 'turn',
    kind: 'turn',
    startTime: 1000,
    endTime: 1010,
    status: 'ok',
    attributes: { sessionId: 'otlp-session', agentId: 'support' },
  });
  await sink.flush();

  assert.equal(requests[0].input, 'https://otel.test/v1/traces');
  const body = JSON.parse(requests[0].init.body);
  const attributes = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  assert.ok(attributes.some((attribute) => attribute.key === 'kuralle.agentId'));
});

test('tracing: sink failure cannot change the recorded run result', () => {
  const recorder = new TraceRecorder({
    sessionId: 'trace-failure',
    agentId: 'support',
    onSpan: () => { throw new Error('telemetry offline'); },
  });
  recorder.record({ channel: 'client', type: 'error', payload: { error: 'model failed' } });
  recorder.record({ channel: 'client', type: 'done', payload: { sessionId: 'trace-failure' } });

  const trace = recorder.finish({ text: '', toolResults: [] });
  const turn = trace.spans.find((span) => span.kind === 'turn');
  assert.equal(turn.status, 'error');
  assert.equal(turn.attributes.error, 'model failed');
});
