import type { StreamPart } from '@kuralle-agents/core';

type Part<T extends StreamPart['type']> = Extract<StreamPart, { type: T }>;

export const filterStreamParts = {
  textDelta: (p: StreamPart): p is Part<'text-delta'> => p.type === 'text-delta',
  toolCall: (p: StreamPart): p is Part<'tool-call'> => p.type === 'tool-call',
  toolResult: (p: StreamPart): p is Part<'tool-result'> => p.type === 'tool-result',
  handoff: (p: StreamPart): p is Part<'handoff'> => p.type === 'handoff',
  nodeEnter: (p: StreamPart): p is Part<'node-enter'> => p.type === 'node-enter',
  nodeExit: (p: StreamPart): p is Part<'node-exit'> => p.type === 'node-exit',
  flowEnter: (p: StreamPart): p is Part<'flow-enter'> => p.type === 'flow-enter',
  flowTransition: (p: StreamPart): p is Part<'flow-transition'> => p.type === 'flow-transition',
  flowEnd: (p: StreamPart): p is Part<'flow-end'> => p.type === 'flow-end',
  turnEnd: (p: StreamPart): p is Part<'turn-end'> => p.type === 'turn-end',
  done: (p: StreamPart): p is Part<'done'> => p.type === 'done',
  errorEvent: (p: StreamPart): p is Part<'error'> => p.type === 'error',
  interrupted: (p: StreamPart): p is Part<'interrupted'> => p.type === 'interrupted',
  paused: (p: StreamPart): p is Part<'paused'> => p.type === 'paused',
  conversationOutcome: (p: StreamPart): p is Part<'conversation-outcome'> =>
    p.type === 'conversation-outcome',
} as const;
