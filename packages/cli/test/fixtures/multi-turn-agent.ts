import type { Runtime, SessionEventLog, StreamPart } from '@kuralle-agents/core';
import { createEventBus, createTurnHandle } from '../../../core/src/events/TurnHandle.js';
import type { BuildRuntime } from '../../src/agentRuntime.js';

function donePart(sessionId: string): StreamPart {
  return { channel: 'client', type: 'done', payload: { sessionId } };
}

function assistantParts(text: string, sessionId: string): StreamPart[] {
  const id = `a-${Date.now()}`;
  return [
    { channel: 'client', type: 'text-start', payload: { id } },
    { channel: 'client', type: 'text-delta', payload: { id, delta: text } },
    { channel: 'client', type: 'text-end', payload: { id } },
    donePart(sessionId),
  ];
}

async function countCompletedTurns(eventLog: SessionEventLog, sessionId: string): Promise<number> {
  const { events } = await eventLog.read(sessionId, 0);
  return events.filter((event) => event.part.type === 'done').length;
}

function multiTurnRuntime(eventLog: SessionEventLog): Runtime {
  const runtime: Pick<Runtime, 'run' | 'abortSession'> = {
    run(runOpts) {
      const sessionId = runOpts.sessionId ?? 'default';
      const input = typeof runOpts.input === 'string' ? runOpts.input : '';
      const bus = createEventBus();
      const runId = `run-${sessionId}-${Date.now()}`;
      const emitAll = async () => {
        const priorTurns = await countCompletedTurns(eventLog, sessionId);
        const turnNumber = runOpts.signalDelivery ? priorTurns : priorTurns + 1;
        const parts = runOpts.signalDelivery
          ? assistantParts(`approved turn ${turnNumber}`, sessionId)
          : assistantParts(`reply ${turnNumber}: ${input}`, sessionId);
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
  };
  return runtime as Runtime;
}

export const buildRuntime: BuildRuntime = (sessionId = 'multi-turn', store, traceStore, eventLog) => ({
  runtime: multiTurnRuntime(eventLog!),
  store: store!,
  sessionId,
  agentId: 'multi-turn',
  label: 'multi-turn stub',
  readState: async () => ({ roles: [] }),
});
