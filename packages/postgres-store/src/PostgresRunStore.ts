import {
  LogConflictError,
  RunNotFoundError,
  RunNotTerminalError,
  StepNotFoundError,
  StaleWriteError,
  isTerminalRunStatus,
  toRunRef,
  type DeleteRunOptions,
  type RunFilter,
  type RunRef,
  type RunState,
  type RunStore,
  type StepFinalizePatch,
  type StepRecord,
} from '@kuralle-agents/core';
import type { QueryResult } from 'pg';

type PostgresClient = {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
};

type PoolClient = PostgresClient & { release: () => void };

type PoolLike = PostgresClient & {
  connect: () => Promise<PoolClient>;
  totalCount: number;
};

export type PostgresRunStoreOptions = {
  client: PostgresClient;
  stateTableName?: string;
  stepsTableName?: string;
  autoMigrate?: boolean;
};

const defaultStateTable = 'kuralle_run_state';
const defaultStepsTable = 'kuralle_run_steps';

type VersionedRunState = RunState & { version?: number };

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

function normalizeTableName(tableName: string, label: string): string {
  if (!/^[a-zA-Z0-9_.]+$/.test(tableName)) {
    throw new Error(`Invalid ${label}: ${tableName}`);
  }
  return tableName;
}

function indexName(table: string, suffix: string): string {
  return `${table.replace(/\./g, '_')}_${suffix}`;
}

function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function jsonParam(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
}

function asOptionalNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  return asNumber(value);
}

function attachedVersion(state: RunState): number {
  const value = (state as VersionedRunState).version;
  return typeof value === 'number' ? value : 0;
}

function stripVersion(state: RunState): RunState {
  const clone = cloneJson(state) as VersionedRunState;
  delete clone.version;
  return clone;
}

function withVersion(state: RunState, version: number): RunState {
  const clone = cloneJson(state) as VersionedRunState;
  clone.version = version;
  return clone;
}

function isPool(client: PostgresClient): client is PoolLike {
  return typeof (client as PoolLike).connect === 'function' && typeof (client as PoolLike).totalCount === 'number';
}

export class PostgresRunStore implements RunStore {
  readonly ready: Promise<void>;
  private readonly client: PostgresClient;
  private readonly stateTable: string;
  private readonly stepsTable: string;

  constructor(options: PostgresRunStoreOptions) {
    this.client = options.client;
    this.stateTable = normalizeTableName(options.stateTableName ?? defaultStateTable, 'state table name');
    this.stepsTable = normalizeTableName(options.stepsTableName ?? defaultStepsTable, 'steps table name');
    this.ready = options.autoMigrate === false ? Promise.resolve() : this.init();
  }

  async appendStep(runId: string, record: StepRecord): Promise<void> {
    await this.ready;
    const params = this.stepParams(runId, record);
    try {
      await this.client.query(
        `INSERT INTO ${this.stepsTable} (
           run_id, index, key, kind, name, status, result, error,
           started_at, finished_at, epoch, signal_id, interrupt_decision
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13::jsonb)`,
        params,
      );
    } catch (error) {
      const code = pgCode(error);
      if (code === '23503') {
        throw new RunNotFoundError(runId);
      }
      if (code !== '23505') {
        throw error;
      }
      try {
        const replaced = await this.client.query(
          `UPDATE ${this.stepsTable}
           SET key = $3, kind = $4, name = $5, status = $6, result = $7::jsonb, error = $8::jsonb,
               started_at = $9, finished_at = $10, epoch = $11, signal_id = $12, interrupt_decision = $13::jsonb
           WHERE run_id = $1 AND index = $2 AND name = '__reserve'`,
          params,
        );
        if ((replaced.rowCount ?? 0) > 0) {
          return;
        }
      } catch (updateError) {
        if (pgCode(updateError) !== '23505') {
          throw updateError;
        }
      }
      throw new LogConflictError(runId, record.index, await this.stepCount(runId));
    }
  }

  async finalizeStep(runId: string, key: string, patch: StepFinalizePatch): Promise<void> {
    await this.ready;
    const sets = ['status = $3'];
    const params: unknown[] = [runId, key, patch.status];
    if ('result' in patch) {
      params.push(jsonParam(patch.result));
      sets.push(`result = $${params.length}::jsonb`);
    }
    if ('error' in patch) {
      params.push(jsonParam(patch.error));
      sets.push(`error = $${params.length}::jsonb`);
    }
    if ('finishedAt' in patch) {
      params.push(patch.finishedAt ?? null);
      sets.push(`finished_at = $${params.length}`);
    }
    const updated = await this.client.query(
      `UPDATE ${this.stepsTable} SET ${sets.join(', ')} WHERE run_id = $1 AND key = $2`,
      params,
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new StepNotFoundError(runId, key);
    }
  }

  async getSteps(runId: string): Promise<StepRecord[]> {
    await this.ready;
    const result = await this.client.query(
      `SELECT index, key, kind, name, status, result, error, started_at, finished_at, epoch, signal_id, interrupt_decision
       FROM ${this.stepsTable} WHERE run_id = $1 ORDER BY index ASC`,
      [runId],
    );
    return result.rows.map((row) => this.parseStep(row));
  }

  async getRunState(runId: string): Promise<RunState | null> {
    await this.ready;
    const result = await this.client.query(
      `SELECT state, version FROM ${this.stateTable} WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0] as { state: unknown; version: number } | undefined;
    if (!row) return null;
    return withVersion(parseJson<RunState>(row.state), asNumber(row.version));
  }

  async putRunState(state: RunState): Promise<void> {
    await this.ready;
    const expected = attachedVersion(state);
    const persisted = stripVersion(state);
    persisted.updatedAt = Date.now();
    const result = await this.client.query(
      `INSERT INTO ${this.stateTable} (run_id, session_id, kind, status, flow_name, state, version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, to_timestamp($7 / 1000.0))
       ON CONFLICT (run_id) DO UPDATE SET
         session_id = EXCLUDED.session_id,
         kind = EXCLUDED.kind,
         status = EXCLUDED.status,
         flow_name = EXCLUDED.flow_name,
         state = EXCLUDED.state,
         version = ${this.stateTable}.version + 1,
         updated_at = EXCLUDED.updated_at
       WHERE $8::int = 0 OR ${this.stateTable}.version = $8
       RETURNING version`,
      [
        persisted.runId,
        persisted.sessionId,
        persisted.kind ?? null,
        persisted.status,
        persisted.activeFlow ?? null,
        JSON.stringify(persisted),
        persisted.updatedAt,
        expected,
      ],
    );
    if ((result.rowCount ?? 0) > 0) {
      (state as VersionedRunState).version = asNumber(result.rows[0]?.version);
      return;
    }
    const current = await this.client.query(
      `SELECT version FROM ${this.stateTable} WHERE run_id = $1`,
      [state.runId],
    );
    const actual = asNumber(current.rows[0]?.version ?? 0);
    throw new StaleWriteError(state.runId, expected, actual);
  }

  async initRun(state: RunState): Promise<void> {
    await this.ready;
    const persisted = stripVersion(state);
    await this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO ${this.stateTable} (run_id, session_id, kind, status, flow_name, state, version, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, to_timestamp($7 / 1000.0))
         ON CONFLICT (run_id) DO UPDATE SET
           session_id = EXCLUDED.session_id,
           kind = EXCLUDED.kind,
           status = EXCLUDED.status,
           flow_name = EXCLUDED.flow_name,
           state = EXCLUDED.state,
           version = 1,
           updated_at = EXCLUDED.updated_at`,
        [
          persisted.runId,
          persisted.sessionId,
          persisted.kind ?? null,
          persisted.status,
          persisted.activeFlow ?? null,
          JSON.stringify(persisted),
          persisted.updatedAt,
        ],
      );
      await client.query(`DELETE FROM ${this.stepsTable} WHERE run_id = $1`, [state.runId]);
    });
    (state as VersionedRunState).version = 1;
  }

  async pruneStepsBeforeEpoch(runId: string, keepEpoch: number): Promise<void> {
    await this.ready;
    await this.withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM ${this.stateTable} WHERE run_id = $1 FOR UPDATE`,
        [runId],
      );
      if (existing.rows.length === 0) return;

      await client.query(
        `DELETE FROM ${this.stepsTable} WHERE run_id = $1 AND epoch IS NOT NULL AND epoch < $2`,
        [runId, keepEpoch],
      );
      const remaining = await client.query(
        `SELECT index, key, kind, name, status, result, error, started_at, finished_at, epoch, signal_id, interrupt_decision
         FROM ${this.stepsTable} WHERE run_id = $1 ORDER BY index ASC`,
        [runId],
      );
      const rows = remaining.rows;
      if (rows.every((row, index) => asNumber(row.index) === index)) {
        return;
      }
      await client.query(`DELETE FROM ${this.stepsTable} WHERE run_id = $1`, [runId]);
      for (let index = 0; index < rows.length; index++) {
        await this.insertStepRow(client, runId, { ...this.parseStep(rows[index]!), index });
      }
    });
  }

  async reserveSteps(runId: string, count: number): Promise<number[]> {
    if (count <= 0) return [];
    await this.ready;
    return this.withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM ${this.stateTable} WHERE run_id = $1 FOR UPDATE`,
        [runId],
      );
      if (existing.rows.length === 0) {
        throw new RunNotFoundError(runId);
      }
      const max = await client.query(
        `SELECT COALESCE(MAX(index) + 1, 0)::int AS start FROM ${this.stepsTable} WHERE run_id = $1`,
        [runId],
      );
      const start = asNumber(max.rows[0]?.start ?? 0);
      const now = Date.now();
      const epochRow = await client.query(
        `SELECT state FROM ${this.stateTable} WHERE run_id = $1`,
        [runId],
      );
      const run = parseJson<RunState>(epochRow.rows[0]?.state);
      const epoch = run.runEpoch ?? 0;
      const indices: number[] = [];
      for (let i = 0; i < count; i++) {
        const index = start + i;
        indices.push(index);
        await this.insertStepRow(client, runId, {
          index,
          key: `__reserve:${runId}:${index}`,
          kind: 'tool',
          name: '__reserve',
          status: 'running',
          startedAt: now,
          epoch,
        });
      }
      return indices;
    });
  }

  async *listRuns(filter: RunFilter): AsyncIterable<RunRef> {
    await this.ready;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filter.kind === 'conversation') {
      clauses.push(`(kind IS NULL OR kind = 'conversation')`);
    } else if (filter.kind === 'flow') {
      clauses.push(`kind = 'flow'`);
    }
    if (filter.flowName !== undefined) {
      params.push(filter.flowName);
      clauses.push(`flow_name = $${params.length}`);
    }
    if (filter.waitingSignalId !== undefined) {
      params.push(filter.waitingSignalId);
      clauses.push(`(state->'waitingFor'->>'requestId') = $${params.length}`);
    }
    if (filter.deadlineBefore !== undefined) {
      params.push(filter.deadlineBefore.getTime());
      clauses.push(
        `(state->'waitingFor'->>'deadline') IS NOT NULL AND (state->'waitingFor'->>'deadline')::double precision < $${params.length}`,
      );
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.client.query(
      `SELECT session_id, state FROM ${this.stateTable} ${where} ORDER BY updated_at ASC`,
      params,
    );
    for (const row of result.rows as Array<{ session_id: string; state: unknown }>) {
      yield cloneJson(toRunRef(parseJson<RunState>(row.state), row.session_id));
    }
  }

  async deleteRun(runId: string, options?: DeleteRunOptions): Promise<void> {
    await this.ready;
    await this.withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT status FROM ${this.stateTable} WHERE run_id = $1 FOR UPDATE`,
        [runId],
      );
      const row = existing.rows[0] as { status: RunState['status'] } | undefined;
      if (!row) {
        throw new RunNotFoundError(runId);
      }
      if (!isTerminalRunStatus(row.status) && !options?.force) {
        throw new RunNotTerminalError(runId, row.status);
      }
      await client.query(`DELETE FROM ${this.stepsTable} WHERE run_id = $1`, [runId]);
      await client.query(`DELETE FROM ${this.stateTable} WHERE run_id = $1`, [runId]);
    });
  }

  private async init(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.stateTable} (
         run_id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         kind TEXT,
         status TEXT NOT NULL,
         flow_name TEXT,
         state JSONB NOT NULL,
         version INT NOT NULL DEFAULT 1,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${indexName(this.stateTable, 'status_kind_idx')}
       ON ${this.stateTable} (status, kind)`,
    );
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.stepsTable} (
         run_id TEXT NOT NULL REFERENCES ${this.stateTable} (run_id) ON DELETE CASCADE,
         index INT NOT NULL,
         key TEXT NOT NULL,
         kind TEXT NOT NULL,
         name TEXT NOT NULL,
         status TEXT,
         result JSONB,
         error JSONB,
         started_at BIGINT NOT NULL,
         finished_at BIGINT,
         epoch INT,
         signal_id TEXT,
         interrupt_decision JSONB,
         PRIMARY KEY (run_id, index)
       )`,
    );
    await this.client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName(this.stepsTable, 'run_key_idx')}
       ON ${this.stepsTable} (run_id, key)`,
    );
  }

  private async withTransaction<T>(fn: (client: PostgresClient) => Promise<T>): Promise<T> {
    if (isPool(this.client)) {
      const conn = await this.client.connect();
      try {
        await conn.query('BEGIN');
        const result = await fn(conn);
        await conn.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await conn.query('ROLLBACK');
        } catch {
          /* the original error is the one to surface */
        }
        throw error;
      } finally {
        conn.release();
      }
    }

    await this.client.query('BEGIN');
    try {
      const result = await fn(this.client);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await this.client.query('ROLLBACK');
      } catch {
        /* the original error is the one to surface */
      }
      throw error;
    }
  }

  private async stepCount(runId: string): Promise<number> {
    const result = await this.client.query(
      `SELECT COUNT(*)::int AS n FROM ${this.stepsTable} WHERE run_id = $1`,
      [runId],
    );
    return asNumber(result.rows[0]?.n ?? 0);
  }

  private stepParams(runId: string, record: StepRecord): unknown[] {
    return [
      runId,
      record.index,
      record.key,
      record.kind,
      record.name,
      record.status ?? null,
      jsonParam(record.result),
      jsonParam(record.error),
      record.startedAt,
      record.finishedAt ?? null,
      record.epoch ?? null,
      record.signalId ?? null,
      jsonParam(record.interruptDecision),
    ];
  }

  private async insertStepRow(client: PostgresClient, runId: string, record: StepRecord): Promise<void> {
    await client.query(
      `INSERT INTO ${this.stepsTable} (
         run_id, index, key, kind, name, status, result, error,
         started_at, finished_at, epoch, signal_id, interrupt_decision
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13::jsonb)`,
      this.stepParams(runId, record),
    );
  }

  private parseStep(row: Record<string, unknown>): StepRecord {
    const record: StepRecord = {
      index: asNumber(row.index),
      key: String(row.key),
      kind: row.kind as StepRecord['kind'],
      name: String(row.name),
      startedAt: asNumber(row.started_at),
    };
    if (row.status != null) record.status = row.status as StepRecord['status'];
    if (row.result != null) record.result = parseJson(row.result);
    if (row.error != null) record.error = parseJson(row.error);
    const finishedAt = asOptionalNumber(row.finished_at);
    if (finishedAt !== undefined) record.finishedAt = finishedAt;
    const epoch = asOptionalNumber(row.epoch);
    if (epoch !== undefined) record.epoch = epoch;
    if (row.signal_id != null) record.signalId = String(row.signal_id);
    if (row.interrupt_decision != null) {
      record.interruptDecision = parseJson(row.interrupt_decision);
    }
    return record;
  }
}
