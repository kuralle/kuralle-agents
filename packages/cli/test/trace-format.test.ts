import { expect, test } from 'bun:test';
import type { AgentTrace } from '@kuralle-agents/core';
import { formatTrace } from '../src/trace.js';

test('trace formatter displays client-observable TTFT', () => {
  const trace: AgentTrace = {
    traceId: '0123456789abcdef0123456789abcdef',
    sessionId: 'ttft-test',
    answer: 'hello',
    usedTool: false,
    toolCalls: [],
    toolResults: [],
    startedAt: 1_000,
    endedAt: 1_250,
    spans: [{
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      name: 'turn',
      kind: 'turn',
      startTime: 1_000,
      endTime: 1_250,
      status: 'ok',
      attributes: { sessionId: 'ttft-test', ttftMs: 125 },
    }],
  };

  expect(formatTrace(trace)).toContain('TTFT 125ms');
});
