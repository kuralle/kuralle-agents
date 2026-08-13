/**
 * Real-Postgres wiring for FlowDefinitionsStore conformance.
 * Keyed on POSTGRES_URL; skips when unset (repo convention).
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import pg from 'pg';
import { flowDefinitionsStoreConformanceCases } from '@kuralle-agents/core/flows/definition/testing';
import { PostgresFlowDefinitionsStore } from '../PostgresFlowDefinitionsStore.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const tableName = `flow_def_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!POSTGRES_URL)('PostgresFlowDefinitionsStore conformance', () => {
  const pool = new pg.Pool({ connectionString: POSTGRES_URL });

  beforeAll(async () => {
    const store = new PostgresFlowDefinitionsStore({ client: pool, tableName });
    await store.list();
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
    await pool.end();
  });

  for (const testCase of flowDefinitionsStoreConformanceCases) {
    it(testCase.name, async () => {
      await pool.query(`TRUNCATE ${tableName}`);
      await testCase.run(new PostgresFlowDefinitionsStore({ client: pool, tableName, autoMigrate: false }));
    });
  }
});
