import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  type Runtime,
  type RunOptions,
  type SessionEventLog,
  type StreamPart,
} from '@kuralle-agents/core';
import { createClient } from '@kuralle-agents/client';
import { createEventBus, createTurnHandle } from '../../core/src/events/TurnHandle.js';
import { runCancel } from '../src/cancel.js';
import { fileSessionEventLog } from '../src/fileEventLog.js';
import type { BuildRuntime } from '../src/agentRuntime.js';

function tmpStore(name = 'sessions.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'kuralle-cancel-')), name);
}

function tmpEvents(storePath: string): string {
  return storePath.replace(/\.json$/, '') + '.events.jsonl';
}

function hangingRuntime(eventLog: SessionEventLog): Runtime {
  const aborts = new Map<string, AbortController>();
  let turn = 0;
  const runtime: Pick<Runtime, 'run' | 'abortSession'> = {
    run(runOpts: RunOptions) {
      const sessionId = runOpts.sessionId ?? 'cancel-sess';
      turn += 1;
      const bus = createEventBus();
      const runId = `run-${sessionId}-${turn}`;
      if (turn > 1) {
        const handle = createTurnHandle({
          run: async () => {
            const parts: StreamPart[] = [
              { channel: 'client', type: 'text-start', payload: { id: 'a2' } },
              { channel: 'client', type: 'text-delta', payload: { id: 'a2', delta: 'ok' } },
              { channel: 'client', type: 'text-end', payload: { id: 'a2' } },
              { channel: 'client', type: 'done', payload: { sessionId } },
            ];
            for (const part of parts) {
              bus.emit(part);
              await eventLog.append(sessionId, [part], runId);
            }
            bus.close();
            return { text: 'ok', toolResults: [], runId };
          },
          bus,
          runId: Promise.resolve(runId),
        });
        return handle;
      }

      const controller = new AbortController();
      aborts.set(sessionId, controller);
      if (runOpts.abortSignal) {
        runOpts.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      const handle = createTurnHandle({
        run: async () => {
          const part: StreamPart = { channel: 'client', type: 'text-start', payload: { id: 'a1' } };
          bus.emit(part);
          await eventLog.append(sessionId, [part], runId);
          return await new Promise<{ text: string; toolResults: []; runId: string }>((resolve) => {
            controller.signal.addEventListener('abort', () => {
              resolve({ text: '', toolResults: [], runId });
            }, { once: true });
          });
        },
        bus,
        runId: Promise.resolve(runId),
      });
      return handle;
    },
    abortSession(sessionId: string) {
      aborts.get(sessionId)?.abort();
    },
  };
  return runtime as Runtime;
}

describe('cancel command', () => {
  it('returns cancelled mid-turn and the next send succeeds', async () => {
    const storePath = tmpStore();
    const eventLog = fileSessionEventLog(tmpEvents(storePath));
    const runtime = hangingRuntime(eventLog);
    const build: BuildRuntime = (sessionId = 'cancel-sess') => ({
      runtime,
      store: new MemoryStore(),
      sessionId,
      agentId: 'cancel-fixture',
      label: 'cancel fixture',
      readState: async () => ({ roles: [] }),
    });

    const client = createClient({ kind: 'local', runtime, eventLog });
    const session = client.sessions.attach('cancel-sess');
    const turn = await session.send('hello');

    const result = await runCancel(['--session', 'cancel-sess', '--store', storePath], build);
    expect(result.status).toBe('cancelled');
    await turn.result();

    const followUp = await session.send('again');
    await followUp.result();
    expect((await eventLog.tail('cancel-sess'))).toBeGreaterThan(0);
  });

  it('returns no_active_turn when nothing is running', async () => {
    const storePath = tmpStore();
    const eventLog = fileSessionEventLog(tmpEvents(storePath));
    const build: BuildRuntime = (sessionId = 'idle-sess') => ({
      runtime: hangingRuntime(eventLog),
      store: new MemoryStore(),
      sessionId,
      agentId: 'cancel-fixture',
      label: 'cancel fixture',
      readState: async () => ({ roles: [] }),
    });
    const result = await runCancel(['--session', 'idle-sess', '--store', storePath], build);
    expect(result.status).toBe('no_active_turn');
  });
});
