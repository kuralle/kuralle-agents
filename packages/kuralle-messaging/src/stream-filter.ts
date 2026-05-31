import type { HarnessStreamPart } from '@kuralle-agents/core';

type Part<T extends HarnessStreamPart['type']> = Extract<HarnessStreamPart, { type: T }>;

export const filterStreamParts = {
  textDelta: (p: HarnessStreamPart): p is Part<'text-delta'> => p.type === 'text-delta',
  toolCall: (p: HarnessStreamPart): p is Part<'tool-call'> => p.type === 'tool-call',
  toolResult: (p: HarnessStreamPart): p is Part<'tool-result'> => p.type === 'tool-result',
  handoff: (p: HarnessStreamPart): p is Part<'handoff'> => p.type === 'handoff',
  nodeEnter: (p: HarnessStreamPart): p is Part<'node-enter'> => p.type === 'node-enter',
  nodeExit: (p: HarnessStreamPart): p is Part<'node-exit'> => p.type === 'node-exit',
  flowEnter: (p: HarnessStreamPart): p is Part<'flow-enter'> => p.type === 'flow-enter',
  flowTransition: (p: HarnessStreamPart): p is Part<'flow-transition'> => p.type === 'flow-transition',
  flowEnd: (p: HarnessStreamPart): p is Part<'flow-end'> => p.type === 'flow-end',
  turnEnd: (p: HarnessStreamPart): p is Part<'turn-end'> => p.type === 'turn-end',
  done: (p: HarnessStreamPart): p is Part<'done'> => p.type === 'done',
  errorEvent: (p: HarnessStreamPart): p is Part<'error'> => p.type === 'error',
  interrupted: (p: HarnessStreamPart): p is Part<'interrupted'> => p.type === 'interrupted',
  paused: (p: HarnessStreamPart): p is Part<'paused'> => p.type === 'paused',
  conversationOutcome: (p: HarnessStreamPart): p is Part<'conversation-outcome'> =>
    p.type === 'conversation-outcome',
} as const;
