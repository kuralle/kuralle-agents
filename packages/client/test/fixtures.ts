import type { StreamPart } from '@kuralle-agents/core';
import type { LoggedEvent } from '../src/reduce.js';

export function logged(
  index: number,
  part: StreamPart,
  overrides: Partial<Omit<LoggedEvent, 'index' | 'part'>> = {},
): LoggedEvent {
  return {
    index,
    eventId: overrides.eventId ?? `evt-${index}`,
    runId: overrides.runId ?? 'run-1',
    at: overrides.at ?? index * 100,
    part,
    ...overrides,
  };
}

export const sampleInterrupt = {
  requestId: 'req-approve-1',
  kind: 'approval' as const,
  signalName: 'tool_approval',
  operation: {
    toolCallId: 'call-refund',
    toolName: 'issue_refund',
    args: { orderId: '4471' },
    argsHash: 'abc123',
  },
  display: { title: 'Approve refund', description: 'Refund $42 for order 4471' },
  responseSchema: { type: 'object' },
  deadline: null,
  allowedDecisions: ['approve', 'deny'] as Array<'approve' | 'deny'>,
  createdAt: 1_700_000_000_000,
};

export const toolTurnEvents: LoggedEvent[] = [
  logged(0, { channel: 'client', type: 'text-start', payload: { id: 'a1' } }, { at: 0 }),
  logged(1, { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: '' } }, { at: 10 }),
  logged(2, { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'Checking' } }, { at: 50 }),
  logged(3, {
    channel: 'internal',
    type: 'tool-call',
    payload: { toolName: 'lookup_order', args: { orderId: '4471' }, toolCallId: 'call-1' },
  }),
  logged(4, {
    channel: 'internal',
    type: 'tool-result',
    payload: {
      toolName: 'lookup_order',
      result: { status: 'shipped' },
      toolCallId: 'call-1',
      preliminary: true,
    },
  }, { at: 400 }),
  logged(5, {
    channel: 'internal',
    type: 'tool-result',
    payload: {
      toolName: 'lookup_order',
      result: { status: 'shipped', carrier: 'DHL' },
      toolCallId: 'call-1',
    },
  }, { at: 500 }),
  logged(6, { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: ' your order.' } }, { at: 550 }),
  logged(7, { channel: 'client', type: 'text-end', payload: { id: 'a1' } }),
  logged(8, { channel: 'client', type: 'done', payload: { sessionId: 's1', usage: { inputTokens: 120, outputTokens: 34 } } }, { at: 600 }),
];

export const flowTurnEvents: LoggedEvent[] = [
  logged(0, { channel: 'internal', type: 'flow-enter', payload: { flow: 'checkout' } }),
  logged(1, { channel: 'internal', type: 'node-enter', payload: { nodeName: 'collect' } }),
  logged(2, { channel: 'internal', type: 'flow-transition', payload: { from: 'collect', to: 'confirm' } }),
  logged(3, { channel: 'internal', type: 'node-exit', payload: { nodeName: 'collect' } }),
  logged(4, { channel: 'internal', type: 'flow-end', payload: { flow: 'checkout', reason: 'completed' } }),
  logged(5, { channel: 'internal', type: 'turn-end', payload: { rendered: 'engine' } }),
  logged(6, { channel: 'client', type: 'done', payload: { sessionId: 's1' } }, { at: 900 }),
];

export const approvalPauseEvents: LoggedEvent[] = [
  logged(0, { channel: 'client', type: 'text-start', payload: { id: 'a1' } }),
  logged(1, { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'Confirm?' } }),
  logged(2, {
    channel: 'internal',
    type: 'paused',
    payload: { waitingFor: 'approval', interrupt: sampleInterrupt },
  }),
];

export const handoffEvents: LoggedEvent[] = [
  logged(0, {
    channel: 'internal',
    type: 'handoff',
    payload: { targetAgent: 'billing', reason: 'refund' },
  }),
  logged(1, { channel: 'client', type: 'done', payload: { sessionId: 's1' } }, { at: 300 }),
];

export const errorEvents: LoggedEvent[] = [
  logged(0, { channel: 'client', type: 'text-start', payload: { id: 'a1' } }),
  logged(1, { channel: 'client', type: 'error', payload: { error: 'upstream exploded' } }),
];

export const lateExtractionEvents: LoggedEvent[] = [
  logged(0, { channel: 'client', type: 'text-start', payload: { id: 'a1' } }),
  logged(1, { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'Done.' } }),
  logged(2, { channel: 'client', type: 'text-end', payload: { id: 'a1' } }),
  logged(3, { channel: 'client', type: 'done', payload: { sessionId: 's1' } }, { at: 500 }),
  logged(4, {
    channel: 'internal',
    type: 'extraction',
    payload: { slug: 'preference.seat', value: 'window', changed: true },
  }, { at: 800, eventId: 'evt-late-extraction' }),
];

export const coverageEvents: LoggedEvent[] = [
  logged(0, { channel: 'internal', type: 'tool-batch-start', payload: { calls: [{ toolCallId: 'c1', toolName: 't' }] } }),
  logged(1, {
    channel: 'internal',
    type: 'model-call-start',
    payload: { callId: 'm1', modelId: 'gpt-4.1-mini', step: 0 },
  }),
  logged(2, {
    channel: 'internal',
    type: 'model-call-end',
    payload: { callId: 'm1', finishReason: 'stop', inputTokens: 10, outputTokens: 5 },
  }),
  logged(3, { channel: 'client', type: 'text-cancel', payload: { id: 'x1', reason: 'superseded' } }),
  logged(4, { channel: 'client', type: 'conversation-outcome', payload: { outcome: 'resolved' } }),
  logged(5, {
    channel: 'internal',
    type: 'interactive',
    payload: {
      nodeId: 'pick',
      prompt: 'Choose',
      options: [{ id: 'a', label: 'A' }],
    },
  }),
  logged(6, {
    channel: 'internal',
    type: 'turn-incomplete',
    payload: { reason: 'length', step: 1, hadText: true },
  }),
  logged(7, {
    channel: 'internal',
    type: 'pipeline-validation-block',
    payload: { rationale: 'ungrounded', userFacingMessage: 'Let me verify.' },
  }),
  logged(8, {
    channel: 'internal',
    type: 'safety-blocked',
    payload: {
      moderator: 'default',
      rationale: 'pii',
      userFacingMessage: 'Cannot help.',
    },
  }),
  logged(9, { channel: 'internal', type: 'wake', payload: { reason: 'scheduled' } }),
  logged(10, {
    channel: 'internal',
    type: 'escalation',
    payload: { reason: 'human needed', outcome: 'queued', summary: 'Queued for agent' },
  }),
  logged(11, {
    channel: 'internal',
    type: 'context-compacted',
    payload: { beforeTokens: 9000, afterTokens: 4000, summarizedCount: 12 },
  }),
  logged(12, { channel: 'internal', type: 'compaction-skipped', payload: { reason: 'under budget' } }),
  logged(13, {
    channel: 'internal',
    type: 'context-overflow-recovered',
    payload: { strippedCount: 3, compacted: true },
  }),
  logged(14, { channel: 'internal', type: 'custom', payload: { name: 'metric', data: { ms: 1 } } }),
  logged(15, {
    channel: 'internal',
    type: 'knowledge-cache-hit',
    payload: { query: 'hours', resultCount: 2, latencyMs: 4 },
  }),
  logged(16, {
    channel: 'internal',
    type: 'knowledge-cache-miss',
    payload: { query: 'policy', latencyMs: 8 },
  }),
  logged(17, {
    channel: 'internal',
    type: 'knowledge-search',
    payload: { query: 'returns', resultCount: 5, latencyMs: 20, layer: 'hybrid' },
  }),
  logged(18, {
    channel: 'internal',
    type: 'knowledge-quality-check',
    payload: {
      query: 'returns',
      quality: 'high',
      topScore: 0.9,
      avgScore: 0.8,
      coverageEstimate: 0.7,
    },
  }),
  logged(19, {
    channel: 'internal',
    type: 'knowledge-reformulation',
    payload: {
      originalQuery: 'return?',
      reformulatedQuery: 'return policy',
      trigger: 'inline',
      latencyMs: 12,
    },
  }),
  logged(20, { channel: 'internal', type: 'interrupted', payload: { reason: 'barge-in', lastStep: 1 } }),
];
