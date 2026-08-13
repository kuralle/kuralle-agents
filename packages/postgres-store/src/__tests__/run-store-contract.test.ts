import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import {
  LogConflictError,
  RunNotFoundError,
  StaleWriteError,
  type RunState,
  type StepRecord,
} from '@kuralle-agents/core';
import { runRunStoreContract } from '@kuralle-agents/core/runtime/durable/testing';
import { PostgresRunStore } from '../PostgresRunStore.js';

/**
 * Opt-in: needs a real PostgreSQL. Unique-violation mapping, row-level CAS,
 * and the shared RunStore contract are storage semantics — pg-mem is not a
 * substitute. Keyed on POSTGRES_URL so `bun run test` skips rather than fails
 * when the database is absent.
 */
const POSTGRES_URL = process.env.POSTGRES_URL;

if (!POSTGRES_URL) {
  console.warn('skip: POSTGRES_URL unset — PostgresRunStore contract');
}

const STATE_TABLE = 'kuralle_run_state_contract';
const STEPS_TABLE = 'kuralle_run_steps_contract';

const T0 = 1_700_000_000_000;

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

describe.skipIf(!POSTGRES_URL)('PostgresRunStore contract', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: POSTGRES_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  runRunStoreContract(async () => {
    const store = new PostgresRunStore({
      client: pool,
      stateTableName: STATE_TABLE,
      stepsTableName: STEPS_TABLE,
    });
    await store.ready;
    await pool.query(`TRUNCATE ${STATE_TABLE} CASCADE`);
    return store;
  });

  test('deleteRun does not remove a run stored under a different session', async () => {
    const store = new PostgresRunStore({
      client: pool,
      stateTableName: STATE_TABLE,
      stepsTableName: STEPS_TABLE,
    });
    await store.ready;
    await pool.query(`TRUNCATE ${STATE_TABLE} CASCADE`);

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
    const store = new PostgresRunStore({
      client: pool,
      stateTableName: STATE_TABLE,
      stepsTableName: STEPS_TABLE,
    });
    await store.ready;
    await pool.query(`TRUNCATE ${STATE_TABLE} CASCADE`);
    await store.putRunState(runState('r-conflict'));
    await store.appendStep('r-conflict', journalStep);

    await expect(store.appendStep('r-conflict', { ...journalStep, key: 'k-dup' })).rejects.toBeInstanceOf(
      LogConflictError,
    );
  });

  test('appendStep on an unknown run is RunNotFoundError', async () => {
    const store = new PostgresRunStore({
      client: pool,
      stateTableName: STATE_TABLE,
      stepsTableName: STEPS_TABLE,
    });
    await store.ready;
    await pool.query(`TRUNCATE ${STATE_TABLE} CASCADE`);

    await expect(store.appendStep('missing', journalStep)).rejects.toBeInstanceOf(RunNotFoundError);
  });

  test('appendStep fills a reserved slot', async () => {
    const store = new PostgresRunStore({
      client: pool,
      stateTableName: STATE_TABLE,
      stepsTableName: STEPS_TABLE,
    });
    await store.ready;
    await pool.query(`TRUNCATE ${STATE_TABLE} CASCADE`);
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
    const store = new PostgresRunStore({
      client: pool,
      stateTableName: STATE_TABLE,
      stepsTableName: STEPS_TABLE,
    });
    await store.ready;
    await pool.query(`TRUNCATE ${STATE_TABLE} CASCADE`);
    await store.putRunState(runState('r-cas'));

    const first = await store.getRunState('r-cas');
    const second = await store.getRunState('r-cas');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    await store.putRunState({ ...first!, status: 'paused' });
    await expect(store.putRunState({ ...second!, status: 'finished' })).rejects.toBeInstanceOf(StaleWriteError);
  });

  test('pruneStepsBeforeEpoch drops earlier epochs and reindexes', async () => {
    const store = new PostgresRunStore({
      client: pool,
      stateTableName: STATE_TABLE,
      stepsTableName: STEPS_TABLE,
    });
    await store.ready;
    await pool.query(`TRUNCATE ${STATE_TABLE} CASCADE`);
    await store.putRunState(runState('r-prune'));
    await store.appendStep('r-prune', { ...journalStep, index: 0, key: 'old', epoch: 0 });
    await store.appendStep('r-prune', { ...journalStep, index: 1, key: 'keep', epoch: 1 });
    await store.appendStep('r-prune', {
      ...journalStep,
      index: 2,
      key: 'legacy',
      epoch: undefined,
    });

    await store.pruneStepsBeforeEpoch('r-prune', 1);
    const steps = await store.getSteps('r-prune');
    expect(steps.map((step) => ({ key: step.key, index: step.index }))).toEqual([
      { key: 'keep', index: 0 },
      { key: 'legacy', index: 1 },
    ]);
  });
});
