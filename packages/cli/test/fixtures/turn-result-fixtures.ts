import type { TurnView } from '@kuralle-agents/client';
import type { TurnResult } from '../../src/turnResult.js';

const emptyView = (): TurnView => ({
  blocks: [],
  status: 'idle',
  pending: [],
  timings: { ttftMs: null, totalMs: null },
  usage: {},
  memory: { extracted: [], compactions: [] },
  cursor: -1,
  startedAt: null,
});

const cursor = { sessionId: 'fixture', index: 3 };

export const completedFixture: TurnResult = {
  status: 'completed',
  message: 'Booked.',
  cursor,
  view: { ...emptyView(), status: 'completed', cursor: 3 },
};

export const waitingFixture: TurnResult = {
  status: 'waiting',
  message: 'One moment.',
  cursor,
  view: { ...emptyView(), status: 'waiting', cursor: 3 },
};

export const inputRequiredFixture: TurnResult = {
  status: 'input-required',
  requests: [{
    requestId: 'req-1',
    kind: 'approval',
    prompt: 'Confirm booking',
    description: 'Book for 4',
    signalName: 'tool_approval',
    toolName: 'book_table',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ],
  }],
  cursor,
  view: {
    ...emptyView(),
    status: 'input-required',
    cursor: 3,
    pending: [{
      requestId: 'req-1',
      kind: 'approval',
      signalName: 'tool_approval',
      operation: {
        toolCallId: 'call-1',
        toolName: 'book_table',
        args: { party: 4 },
        argsHash: 'abc',
      },
      display: { title: 'Confirm booking', description: 'Book for 4' },
      responseSchema: { type: 'object' },
      deadline: null,
      allowedDecisions: ['approve', 'deny'],
      createdAt: 1,
    }],
  },
};

export const escalatedFixture: TurnResult = {
  status: 'escalated',
  reason: 'human needed',
  cursor,
  view: {
    ...emptyView(),
    status: 'escalated',
    cursor: 3,
    blocks: [{
      id: 'n1',
      kind: 'notice',
      level: 'warn',
      text: 'human needed',
    }],
  },
};

export const failedFixture: TurnResult = {
  status: 'failed',
  message: 'upstream exploded',
  cursor,
};

export const authRequiredFixture: TurnResult = {
  status: 'auth-required',
  message: 'No OPENAI_API_KEY',
  code: 'OPENAI_API_KEY',
};

export const statusFixtures: Record<TurnResult['status'], TurnResult> = {
  completed: completedFixture,
  waiting: waitingFixture,
  'input-required': inputRequiredFixture,
  escalated: escalatedFixture,
  failed: failedFixture,
  'auth-required': authRequiredFixture,
};
