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

  test('attributes the turn span to the initiating agent', () => {
    const recorder = new TraceRecorder({ sessionId: 'session-agent', agentId: 'support' });
    recorder.record({ channel: 'client', type: 'done', payload: { sessionId: 'session-agent' } });

    const turn = recorder.finish({ text: '', toolResults: [] }).spans.find((span) => span.kind === 'turn');
    expect(turn?.attributes.agentId).toBe('support');
  });

  test('attributes post-handoff spans without rewriting the initiating agent', () => {
    const recorder = new TraceRecorder({ sessionId: 'session-handoff', agentId: 'support' });
    recorder.record({
      channel: 'internal',
      type: 'handoff',
      payload: { targetAgent: 'billing', reason: 'billing request' },
    });
    recorder.record({
      channel: 'internal',
      type: 'tool-call',
      payload: { toolName: 'invoice', toolCallId: 'call-1', args: {} },
    });
    recorder.record({
      channel: 'internal',
      type: 'tool-result',
      payload: { toolName: 'invoice', toolCallId: 'call-1', result: { total: 42 } },
    });
    recorder.record({ channel: 'client', type: 'done', payload: { sessionId: 'session-handoff' } });

    const trace = recorder.finish({ text: '', toolResults: [] });
    const turn = trace.spans.find((span) => span.kind === 'turn');
    const handoff = trace.spans.find((span) => span.kind === 'handoff');
    const tool = trace.spans.find((span) => span.kind === 'tool');
    expect(turn?.attributes.agentId).toBe('support');
    expect(handoff?.attributes).toMatchObject({
      agentId: 'support',
      handoffFrom: 'support',
      handoffTo: 'billing',
    });
    expect(tool?.attributes.agentId).toBe('billing');
  });

  test('sets the initiating agent after durable run state is opened', () => {
    const recorder = new TraceRecorder({ sessionId: 'session-resume', agentId: 'default' });
    recorder.setInitiatingAgent('specialist');
    recorder.record({ channel: 'client', type: 'done', payload: { sessionId: 'session-resume' } });

    const turn = recorder.finish({ text: '', toolResults: [] }).spans.find((span) => span.kind === 'turn');
    expect(turn?.attributes.agentId).toBe('specialist');
  });

  test('emits cacheReadTokens and cacheWriteTokens on the turn span', () => {
    const recorder = new TraceRecorder({ sessionId: 'session-cache' });
    recorder.record({
      channel: 'client',
      type: 'done',
      payload: {
        sessionId: 'session-cache',
        usage: {
          inputTokens: 1000,
          outputTokens: 20,
          contextTokens: 1000,
          cacheReadTokens: 800,
          cacheWriteTokens: 150,
        },
      },
    });
    const turn = recorder.finish({ text: '', toolResults: [] }).spans.find((span) => span.kind === 'turn');
    expect(turn?.attributes.cacheReadTokens).toBe(800);
    expect(turn?.attributes.cacheWriteTokens).toBe(150);
    expect(turn?.attributes.tokensIn).toBe(1000);
  });
});
