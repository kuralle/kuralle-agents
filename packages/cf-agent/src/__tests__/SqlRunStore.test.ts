import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DURABLE_RUNS_KEY,
  LogConflictError,
  RunNotFoundError,
  StaleWriteError,
  type RunState,
  type SessionDurableRuns,
  type StepRecord,
} from '@kuralle-agents/core';
import { runRunStoreContract } from '@kuralle-agents/core/runtime/durable/testing';
import type { SqlExecutor } from '../types.js';
import { SqlRunStore } from '../SqlRunStore.js';
import { BridgeSessionStore } from '../BridgeSessionStore.js';
import { OrchestrationStore } from '../OrchestrationStore.js';

const T0 = 1_700_000_000_000;

function bunSql(db: Database = new Database(':memory:')): SqlExecutor {
  db.exec('PRAGMA foreign_keys = ON');
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? '?' : ''),
      '',
    ).trim();
    if (!query) return [];
    if (/^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
      return db.prepare(query).all(...values);
    }
    db.prepare(query).run(...values);
    return [];
  }) as SqlExecutor;
}

function runState(runId: string, overrides: Partial<RunState> = {}): RunState {
  return {
    runId,
    sessionId: 'conformance',
    status: 'running',
    activeAgentId: 'agent-1',
    state: {},
    messages: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const journalStep: StepRecord = {
  index: 0,
  key: 'k0',
  kind: 'tool',
  name: 'charge',
  status: 'finished',
  startedAt: T0,
  finishedAt: T0,
  epoch: 0,
};

runRunStoreContract(
  () => new SqlRunStore(bunSql()),
  { describe, test, expect, beforeEach },
);

describe('SqlRunStore sqlite dialect', () => {
  test('deleteRun does not remove a run stored under a different session', async () => {
    const store = new SqlRunStore(bunSql());
    await store.putRunState(runState('run-a', { sessionId: 'sess-a', status: 'finished' }));
    await store.appendStep('run-a', journalStep);
    await store.putRunState(runState('run-b', { sessionId: 'sess-b', status: 'finished' }));
    await store.appendStep('run-b', { ...journalStep, key: 'k-b' });

    await store.deleteRun('run-a');

    expect(await store.getRunState('run-a')).toBeNull();
    expect(await store.getSteps('run-a')).toEqual([]);
    expect((await store.getRunState('run-b'))?.sessionId).toBe('sess-b');
    expect((await store.getSteps('run-b')).map((step) => step.key)).toEqual(['k-b']);
  });

  test('appendStep maps unique-violation to LogConflictError without a pre-check', async () => {
    const store = new SqlRunStore(bunSql());
    await store.putRunState(runState('r-conflict'));
    await store.appendStep('r-conflict', journalStep);

    await expect(store.appendStep('r-conflict', { ...journalStep, key: 'k-dup' })).rejects.toBeInstanceOf(
      LogConflictError,
    );
  });

  test('appendStep on an unknown run is RunNotFoundError', async () => {
    const store = new SqlRunStore(bunSql());
    await expect(store.appendStep('missing', journalStep)).rejects.toBeInstanceOf(RunNotFoundError);
  });

  test('appendStep fills a reserved slot', async () => {
    const store = new SqlRunStore(bunSql());
    await store.putRunState(runState('r-reserve'));
    const indices = await store.reserveSteps('r-reserve', 2);
    expect(indices).toEqual([0, 1]);

    await store.appendStep('r-reserve', {
      index: 0,
      key: 'real-0',
      kind: 'tool',
      name: 'charge',
      status: 'running',
      startedAt: T0,
      epoch: 0,
    });

    const steps = await store.getSteps('r-reserve');
    expect(steps.map((step) => step.name)).toEqual(['charge', '__reserve']);
    expect(steps[0]?.key).toBe('real-0');
  });

  test('putRunState version mismatch surfaces StaleWriteError', async () => {
    const store = new SqlRunStore(bunSql());
    await store.putRunState(runState('r-cas'));
    const first = await store.getRunState('r-cas');
    const second = await store.getRunState('r-cas');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    await store.putRunState({ ...first!, status: 'paused' });
    await expect(store.putRunState({ ...second!, status: 'finished' })).rejects.toBeInstanceOf(StaleWriteError);
  });

  test('pruneStepsBeforeEpoch drops earlier epochs and reindexes', async () => {
    const store = new SqlRunStore(bunSql());
    await store.putRunState(runState('r-prune'));
    await store.appendStep('r-prune', { ...journalStep, index: 0, key: 'old', epoch: 0 });
    await store.appendStep('r-prune', { ...journalStep, index: 1, key: 'keep', epoch: 1 });
    await store.appendStep('r-prune', { ...journalStep, index: 2, key: 'legacy', epoch: undefined });

    await store.pruneStepsBeforeEpoch('r-prune', 1);
    const steps = await store.getSteps('r-prune');
    expect(steps.map((step) => ({ key: step.key, index: step.index }))).toEqual([
      { key: 'keep', index: 0 },
      { key: 'legacy', index: 1 },
    ]);
  });

  test('listRuns deadlineBefore uses the json_extract index', async () => {
    const db = new Database(':memory:');
    const store = new SqlRunStore(bunSql(db));
    await store.putRunState(runState('r-idx'));
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT session_id, state FROM kuralle_run_state
       WHERE json_extract(state, '$.waitingFor.deadline') IS NOT NULL
         AND json_extract(state, '$.waitingFor.deadline') < ?`,
    ).all(T0) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join(' ');
    expect(details.toLowerCase()).toContain('kuralle_run_state_deadline_idx');
  });

  test('importLegacyRuns copies a blob journal once and will not clobber SQL', async () => {
    const store = new SqlRunStore(bunSql());
    const legacy: SessionDurableRuns = {
      'r-legacy': {
        runState: runState('r-legacy', { status: 'paused' }),
        steps: [journalStep],
      },
    };
    await store.importLegacyRuns(legacy);
    expect((await store.getRunState('r-legacy'))?.status).toBe('paused');
    expect((await store.getSteps('r-legacy')).map((step) => step.key)).toEqual(['k0']);

    const current = await store.getRunState('r-legacy');
    await store.putRunState({ ...current!, status: 'running' });
    await store.importLegacyRuns(legacy);
    expect((await store.getRunState('r-legacy'))?.status).toBe('running');
  });
});

describe('BridgeSessionStore durableRuns migration', () => {
  test('save omits durableRuns so new runs are not written into the blob', async () => {
    const sql = bunSql();
    const store = new BridgeSessionStore({
      sqlExecutor: sql,
      cfMessages: [],
      sessionId: 'thread-1',
      defaultAgentId: 'support',
    });
    const session = await store.get('thread-1');
    expect(session).not.toBeNull();
    (session as { [DURABLE_RUNS_KEY]?: SessionDurableRuns })[DURABLE_RUNS_KEY] = {
      'thread-1': { runState: runState('thread-1'), steps: [journalStep] },
    };
    await store.save(session!);
    const restored = await store.get('thread-1');
    expect((restored as { [DURABLE_RUNS_KEY]?: SessionDurableRuns })[DURABLE_RUNS_KEY]).toEqual({});
  });

  test('get still hydrates a legacy durableRuns blob', async () => {
    const sql = bunSql();
    const orch = new OrchestrationStore(sql);
    await orch.save('thread-1', {
      currentAgent: 'support',
      workingMemory: {},
      agentStates: {},
      handoffHistory: [],
      durableRuns: {
        'thread-1': { runState: runState('thread-1', { sessionId: 'thread-1' }), steps: [journalStep] },
      },
      version: 0,
    });
    const store = new BridgeSessionStore({
      sqlExecutor: sql,
      cfMessages: [],
      sessionId: 'thread-1',
      defaultAgentId: 'support',
    });
    const restored = await store.get('thread-1');
    const runs = (restored as { [DURABLE_RUNS_KEY]?: SessionDurableRuns })[DURABLE_RUNS_KEY];
    expect(runs?.['thread-1']?.runState.runId).toBe('thread-1');
    expect(runs?.['thread-1']?.steps.map((step) => step.key)).toEqual(['k0']);
  });
});
