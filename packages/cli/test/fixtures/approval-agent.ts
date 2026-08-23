import type { Runtime, SessionEventLog, StreamPart } from '@kuralle-agents/core';
import { createEventBus, createTurnHandle } from '../../../core/src/events/TurnHandle.js';
import type { BuildRuntime } from '../../src/agentRuntime.js';

const sampleInterrupt = {
  requestId: 'req-approve-1',
  kind: 'approval' as const,
  signalName: 'tool_approval',
  operation: {
    toolCallId: 'call-book',
    toolName: 'book_table',
    args: { party: 4 },
    argsHash: 'abc',
  },
  display: { title: 'Confirm booking', description: 'Book for 4' },
  responseSchema: { type: 'object' },
  deadline: null,
  allowedDecisions: ['approve', 'deny'] as Array<'approve' | 'deny'>,
  createdAt: 1,
};

function donePart(sessionId: string): StreamPart {
  return { channel: 'client', type: 'done', payload: { sessionId } };
}

function approvalRuntime(eventLog: SessionEventLog): Runtime {
  let approved = false;
  const runtime: Pick<Runtime, 'run' | 'abortSession' | 'settled'> = {
    run(runOpts) {
      const sessionId = runOpts.sessionId ?? 'default';
      const bus = createEventBus();
      const runId = `run-${sessionId}`;
      const emitAll = async () => {
        const parts: StreamPart[] = runOpts.signalDelivery
          ? [
            { channel: 'client', type: 'text-start', payload: { id: 'a2' } },
            { channel: 'client', type: 'text-delta', payload: { id: 'a2', delta: 'Booked for four.' } },
            { channel: 'client', type: 'text-end', payload: { id: 'a2' } },
            donePart(sessionId),
          ]
          : approved
            ? [
              { channel: 'client', type: 'text-start', payload: { id: 'a1' } },
              { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'Already booked.' } },
              { channel: 'client', type: 'text-end', payload: { id: 'a1' } },
              donePart(sessionId),
            ]
            : [
              { channel: 'client', type: 'text-start', payload: { id: 'a1' } },
              { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'Confirm?' } },
              {
                channel: 'internal',
                type: 'paused',
                payload: { waitingFor: 'approval', interrupt: sampleInterrupt },
              },
            ];
        if (runOpts.signalDelivery) {
          approved = true;
        }
        for (const part of parts) {
          bus.emit(part);
          await eventLog.append(sessionId, [part], runId);
        }
        bus.close();
      };
      const pending = emitAll();
      const handle = createTurnHandle({
        run: async () => {
          await pending;
          return { text: '', toolResults: [], runId };
        },
        bus,
        runId: Promise.resolve(runId),
      });
      return handle;
    },
    abortSession() {},
    // send() awaits this before reading the log; a stub does no background work, but the cast to
    // Runtime has to stay honest about every method the CLI calls.
    async settled() {},
  };
  return runtime as Runtime;
}

export const buildRuntime: BuildRuntime = (sessionId = 'approval', store, traceStore, eventLog) => ({
  runtime: approvalRuntime(eventLog!),
  store: store!,
  sessionId,
  agentId: 'approval',
  label: 'approval stub',
  readState: async () => ({ roles: [] }),
});
