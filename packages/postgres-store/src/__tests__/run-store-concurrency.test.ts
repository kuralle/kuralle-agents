import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';
import { LogConflictError, type StepRecord } from '@kuralle-agents/core';
import { PostgresRunStore } from '../PostgresRunStore.js';

/**
 * Opt-in: needs a real PostgreSQL. Two pool clients racing an INSERT at the
 * same (run_id, index) is a unique-constraint property pg-mem does not model.
 * Keyed on POSTGRES_URL so `bun run test` skips rather than fails when unset.
 */
const POSTGRES_URL = process.env.POSTGRES_URL;

if (!POSTGRES_URL) {
  console.warn('skip: POSTGRES_URL unset — PostgresRunStore concurrency');
}

const STATE_TABLE = 'kuralle_run_state_conc';
const STEPS_TABLE = 'kuralle_run_steps_conc';
const T0 = 1_700_000_000_000;

function step(key: string): StepRecord {
  return {
    index: 0,
    key,
    kind: 'tool',
    name: 'charge',
    status: 'running',
    startedAt: T0,
    epoch: 0,
  };
}

describe.skipIf(!POSTGRES_URL)('PostgresRunStore concurrency', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 8 });
    const bootstrap = new PostgresRunStore({
      client: pool,
      stateTableName: STATE_TABLE,
      stepsTableName: STEPS_TABLE,
    });
    await bootstrap.ready;
  });

  afterAll(async () => {
    await pool.end();
  });

  test('two clients appending the same index: one INSERT wins, loser is LogConflictError', async () => {
    await pool.query(`TRUNCATE ${STATE_TABLE} CASCADE`);
    const setup = new PostgresRunStore({
      client: pool,
      stateTableName: STATE_TABLE,
      stepsTableName: STEPS_TABLE,
      autoMigrate: false,
    });
    await setup.putRunState({
      runId: 'r-race',
      sessionId: 'sess-race',
      status: 'running',
      activeAgentId: 'agent-1',
      state: {},
      messages: [],
      createdAt: T0,
      updatedAt: T0,
    });

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      const storeA = new PostgresRunStore({
        client: clientA,
        stateTableName: STATE_TABLE,
        stepsTableName: STEPS_TABLE,
        autoMigrate: false,
      });
      const storeB = new PostgresRunStore({
        client: clientB,
        stateTableName: STATE_TABLE,
        stepsTableName: STEPS_TABLE,
        autoMigrate: false,
      });

      const settled = await Promise.allSettled([
        storeA.appendStep('r-race', step('writer-a')),
        storeB.appendStep('r-race', step('writer-b')),
      ]);

      const fulfilled = settled.filter((result) => result.status === 'fulfilled');
      const rejected = settled.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ status: 'rejected' });
      if (rejected[0]?.status === 'rejected') {
        expect(rejected[0].reason).toBeInstanceOf(LogConflictError);
      }

      const steps = await setup.getSteps('r-race');
      expect(steps).toHaveLength(1);
      expect(['writer-a', 'writer-b']).toContain(steps[0]?.key);
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});
