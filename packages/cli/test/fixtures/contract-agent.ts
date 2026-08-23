import type { Runtime, SessionEventLog, StreamPart } from '@kuralle-agents/core';
import { createEventBus, createTurnHandle } from '../../../core/src/events/TurnHandle.js';
import type { BuildRuntime } from '../../src/agentRuntime.js';

type Scenario = 'completed' | 'waiting' | 'input-required' | 'escalated' | 'failed';

function donePart(sessionId: string): StreamPart {
  return { channel: 'client', type: 'done', payload: { sessionId } };
}

function partsFor(scenario: Scenario, sessionId: string): StreamPart[] {
  switch (scenario) {
    case 'completed':
      return [
        { channel: 'client', type: 'text-start', payload: { id: 'a1' } },
        { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'Done.' } },
        { channel: 'client', type: 'text-end', payload: { id: 'a1' } },
        donePart(sessionId),
      ];
    case 'waiting':
      return [
        { channel: 'client', type: 'text-start', payload: { id: 'a1' } },
        { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'One moment.' } },
        { channel: 'internal', type: 'turn-end', payload: { rendered: 'engine' } },
      ];
    case 'input-required':
      return [
        { channel: 'client', type: 'text-start', payload: { id: 'a1' } },
        { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'Confirm?' } },
        {
          channel: 'internal',
          type: 'paused',
          payload: {
            waitingFor: 'approval',
            interrupt: {
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
            },
          },
        },
      ];
    case 'escalated':
      return [
        {
          channel: 'internal',
          type: 'escalation',
          payload: { reason: 'human needed', outcome: 'queued', summary: 'Queued' },
        },
        donePart(sessionId),
      ];
    case 'failed':
      return [
        { channel: 'client', type: 'error', payload: { error: 'upstream exploded' } },
      ];
  }
}

function stubRuntime(eventLog: SessionEventLog, scenario: Scenario): Runtime {
  const runtime: Pick<Runtime, 'run' | 'abortSession' | 'settled'> = {
    run(runOpts) {
      const sessionId = runOpts.sessionId ?? 'default';
      const parts = partsFor(scenario, sessionId);
      const bus = createEventBus();
      const runId = `run-${sessionId}`;
      const emitAll = async () => {
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

export function buildContractRuntime(scenario: Scenario = 'completed'): BuildRuntime {
  return (sessionId = 'contract', store, traceStore, eventLog) => ({
    runtime: stubRuntime(eventLog!, scenario),
    store: store!,
    sessionId,
    agentId: 'contract',
    label: 'contract stub',
    readState: async () => ({ roles: [] }),
  });
}

export const buildRuntime = buildContractRuntime('completed');
