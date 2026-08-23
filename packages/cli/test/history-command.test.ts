import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runtime, RunOptions, SessionEventLog, StreamPart } from '@kuralle-agents/core';
import { createEventBus, createTurnHandle } from '../../core/src/events/TurnHandle.js';
import { runHistory } from '../src/history.js';
import { fileSessionEventLog } from '../src/fileEventLog.js';
import type { BuildRuntime } from '../src/agentRuntime.js';
import { fileSessionStore } from '../src/fileStore.js';

function tmpStore(name = 'sessions.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'kuralle-history-')), name);
}

function donePart(sessionId: string): StreamPart {
  return { channel: 'client', type: 'done', payload: { sessionId } };
}

function userTurn(text: string): StreamPart {
  return { channel: 'internal', type: 'custom', payload: { name: 'user-turn', data: { text } } };
}

function assistantTurn(label: string, sessionId: string): StreamPart[] {
  return [
    { channel: 'client', type: 'text-start', payload: { id: `${label}-a` } },
    { channel: 'client', type: 'text-delta', payload: { id: `${label}-a`, delta: `${label}-reply` } },
    { channel: 'client', type: 'text-end', payload: { id: `${label}-a` } },
    donePart(sessionId),
  ];
}

function historyRuntime(eventLog: SessionEventLog): Runtime {
  let turn = 0;
  const runtime: Pick<Runtime, 'run' | 'abortSession'> = {
    run(runOpts: RunOptions) {
      const sessionId = runOpts.sessionId ?? 'history-sess';
      const input = typeof runOpts.input === 'string' ? runOpts.input : `turn-${turn}`;
      turn += 1;
      const bus = createEventBus();
      const runId = `run-${turn}`;
      const handle = createTurnHandle({
        run: async () => {
          await eventLog.append(sessionId, [userTurn(input)], runId);
          for (const part of assistantTurn(`t${turn}`, sessionId)) {
            bus.emit(part);
            await eventLog.append(sessionId, [part], runId);
          }
          bus.close();
          return { text: `${input}-reply`, toolResults: [], runId };
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

function buildHistoryHarness(eventLog: SessionEventLog, storePath: string): BuildRuntime {
  const store = fileSessionStore(storePath);
  return (sessionId = 'history-sess') => ({
    runtime: historyRuntime(eventLog),
    store,
    sessionId,
    agentId: 'history-fixture',
    label: 'history fixture',
    readState: async () => ({ roles: [] }),
  });
}

describe('history command', () => {
  it('prints three user and three assistant blocks for a three-turn session', async () => {
    const storePath = tmpStore();
    const eventLog = fileSessionEventLog(storePath.replace(/\.json$/, '') + '.events.jsonl');
    const build = buildHistoryHarness(eventLog, storePath);
    const sessionId = 'history-sess';

    for (const message of ['one', 'two', 'three']) {
      const demo = await build(sessionId);
      await demo.runtime.run({ sessionId, input: message });
    }

    const view = await runHistory(['--session', sessionId, '--store', storePath], build);
    const users = view.blocks.filter((block) => block.kind === 'user');
    const assistants = view.blocks.filter((block) => block.kind === 'assistant');
    expect(users).toHaveLength(3);
    expect(assistants).toHaveLength(3);
  });
});
