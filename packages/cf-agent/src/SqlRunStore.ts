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
  type SessionDurableRuns,
  type StepFinalizePatch,
  type StepRecord,
} from '@kuralle-agents/core';
import type { SqlExecutor } from './types.js';

type VersionedRunState = RunState & { version?: number };

type Clause = {
  sql: string;
  value?: unknown;
  tail?: string;
};

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

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  if (typeof code === 'string') return code;
  if (typeof code === 'number') return String(code);
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sqliteConstraint(error: unknown): 'unique' | 'foreign' | undefined {
  const message = errorMessage(error);
  const code = errorCode(error) ?? '';
  if (
    /FOREIGN KEY constraint failed/i.test(message) ||
    code.includes('CONSTRAINT_FOREIGNKEY')
  ) {
    return 'foreign';
  }
  if (
    /UNIQUE constraint failed/i.test(message) ||
    code.includes('CONSTRAINT_UNIQUE') ||
    code.includes('CONSTRAINT_PRIMARYKEY')
  ) {
    return 'unique';
  }
  return undefined;
}

function tagged(parts: string[]): TemplateStringsArray {
  return Object.assign(parts, { raw: parts }) as TemplateStringsArray;
}

export class SqlRunStore implements RunStore {
  private initialized = false;

  constructor(private readonly sql: SqlExecutor) {
    this.ensureTables();
  }

  async appendStep(runId: string, record: StepRecord): Promise<void> {
    this.ensureTables();
    const params = this.stepParams(runId, record);
    try {
      this.insertStep(params);
    } catch (error) {
      if (sqliteConstraint(error) === 'foreign') {
        throw new RunNotFoundError(runId);
      }
      if (sqliteConstraint(error) !== 'unique') {
        throw error;
      }
      try {
        const replaced = this.sql<{ index: number }>`
          UPDATE kuralle_run_steps
          SET key = ${record.key}, kind = ${record.kind}, name = ${record.name},
              status = ${record.status ?? null}, result = ${jsonParam(record.result)},
              error = ${jsonParam(record.error)}, started_at = ${record.startedAt},
              finished_at = ${record.finishedAt ?? null}, epoch = ${record.epoch ?? null},
              signal_id = ${record.signalId ?? null},
              interrupt_decision = ${jsonParam(record.interruptDecision)}
          WHERE run_id = ${runId} AND "index" = ${record.index} AND name = ${'__reserve'}
          RETURNING "index"
        `;
        if (replaced.length > 0) {
          return;
        }
      } catch (updateError) {
        if (sqliteConstraint(updateError) !== 'unique') {
          throw updateError;
        }
      }
      throw new LogConflictError(runId, record.index, await this.stepCount(runId));
    }
  }

  async finalizeStep(runId: string, key: string, patch: StepFinalizePatch): Promise<void> {
    this.ensureTables();
    const chunks = ['UPDATE kuralle_run_steps SET status = '];
    const values: unknown[] = [patch.status];
    if ('result' in patch) {
      chunks.push(', result = ');
      values.push(jsonParam(patch.result));
    }
    if ('error' in patch) {
      chunks.push(', error = ');
      values.push(jsonParam(patch.error));
    }
    if ('finishedAt' in patch) {
      chunks.push(', finished_at = ');
      values.push(patch.finishedAt ?? null);
    }
    chunks.push(' WHERE run_id = ');
    values.push(runId);
    chunks.push(' AND key = ');
    values.push(key);
    chunks.push(' RETURNING key');
    const updated = this.sql<{ key: string }>(tagged(chunks), ...values);
    if (updated.length === 0) {
      throw new StepNotFoundError(runId, key);
    }
  }

  async getSteps(runId: string): Promise<StepRecord[]> {
    this.ensureTables();
    const rows = this.sql<Record<string, unknown>>`
      SELECT "index", key, kind, name, status, result, error, started_at, finished_at,
             epoch, signal_id, interrupt_decision
      FROM kuralle_run_steps WHERE run_id = ${runId} ORDER BY "index" ASC
    `;
    return rows.map((row) => this.parseStep(row));
  }

  async getRunState(runId: string): Promise<RunState | null> {
    this.ensureTables();
    const rows = this.sql<{ state: string; version: number }>`
      SELECT state, version FROM kuralle_run_state WHERE run_id = ${runId}
    `;
    const row = rows[0];
    if (!row) return null;
    return withVersion(parseJson<RunState>(row.state), asNumber(row.version));
  }

  async putRunState(state: RunState): Promise<void> {
    this.ensureTables();
    const expected = attachedVersion(state);
    const persisted = stripVersion(state);
    persisted.updatedAt = Date.now();
    const result = this.sql<{ version: number }>`
      INSERT INTO kuralle_run_state (run_id, session_id, kind, status, flow_name, state, version, updated_at)
      VALUES (
        ${persisted.runId}, ${persisted.sessionId}, ${persisted.kind ?? null},
        ${persisted.status}, ${persisted.activeFlow ?? null}, ${JSON.stringify(persisted)},
        ${1}, ${persisted.updatedAt}
      )
      ON CONFLICT (run_id) DO UPDATE SET
        session_id = excluded.session_id,
        kind = excluded.kind,
        status = excluded.status,
        flow_name = excluded.flow_name,
        state = excluded.state,
        version = kuralle_run_state.version + 1,
        updated_at = excluded.updated_at
      WHERE ${expected} = 0 OR kuralle_run_state.version = ${expected}
      RETURNING version
    `;
    if (result.length > 0) {
      (state as VersionedRunState).version = asNumber(result[0]?.version);
      return;
    }
    const current = this.sql<{ version: number }>`
      SELECT version FROM kuralle_run_state WHERE run_id = ${state.runId}
    `;
    throw new StaleWriteError(state.runId, expected, asNumber(current[0]?.version ?? 0));
  }

  async initRun(state: RunState): Promise<void> {
    this.ensureTables();
    const persisted = stripVersion(state);
    await this.withTransaction(() => {
      this.sql`
        INSERT INTO kuralle_run_state (run_id, session_id, kind, status, flow_name, state, version, updated_at)
        VALUES (
          ${persisted.runId}, ${persisted.sessionId}, ${persisted.kind ?? null},
          ${persisted.status}, ${persisted.activeFlow ?? null}, ${JSON.stringify(persisted)},
          ${1}, ${persisted.updatedAt}
        )
        ON CONFLICT (run_id) DO UPDATE SET
          session_id = excluded.session_id,
          kind = excluded.kind,
          status = excluded.status,
          flow_name = excluded.flow_name,
          state = excluded.state,
          version = 1,
          updated_at = excluded.updated_at
      `;
      this.sql`DELETE FROM kuralle_run_steps WHERE run_id = ${state.runId}`;
    });
    (state as VersionedRunState).version = 1;
  }

  async pruneStepsBeforeEpoch(runId: string, keepEpoch: number): Promise<void> {
    this.ensureTables();
    await this.withTransaction(() => {
      const existing = this.sql<{ run_id: string }>`
        SELECT run_id FROM kuralle_run_state WHERE run_id = ${runId}
      `;
      if (existing.length === 0) return;

      this.sql`
        DELETE FROM kuralle_run_steps
        WHERE run_id = ${runId} AND epoch IS NOT NULL AND epoch < ${keepEpoch}
      `;
      const remaining = this.sql<Record<string, unknown>>`
        SELECT "index", key, kind, name, status, result, error, started_at, finished_at,
               epoch, signal_id, interrupt_decision
        FROM kuralle_run_steps WHERE run_id = ${runId} ORDER BY "index" ASC
      `;
      if (remaining.every((row, index) => asNumber(row.index) === index)) {
        return;
      }
      this.sql`DELETE FROM kuralle_run_steps WHERE run_id = ${runId}`;
      for (let index = 0; index < remaining.length; index++) {
        this.insertStep(this.stepParams(runId, { ...this.parseStep(remaining[index]!), index }));
      }
    });
  }

  async reserveSteps(runId: string, count: number): Promise<number[]> {
    if (count <= 0) return [];
    this.ensureTables();
    return this.withTransaction(() => {
      const existing = this.sql<{ run_id: string }>`
        SELECT run_id FROM kuralle_run_state WHERE run_id = ${runId}
      `;
      if (existing.length === 0) {
        throw new RunNotFoundError(runId);
      }
      const max = this.sql<{ start: number }>`
        SELECT COALESCE(MAX("index") + 1, 0) AS start FROM kuralle_run_steps WHERE run_id = ${runId}
      `;
      const start = asNumber(max[0]?.start ?? 0);
      const now = Date.now();
      const epochRow = this.sql<{ state: string }>`
        SELECT state FROM kuralle_run_state WHERE run_id = ${runId}
      `;
      const run = parseJson<RunState>(epochRow[0]?.state);
      const epoch = run.runEpoch ?? 0;
      const indices: number[] = [];
      for (let i = 0; i < count; i++) {
        const index = start + i;
        indices.push(index);
        this.insertStep(
          this.stepParams(runId, {
            index,
            key: `__reserve:${runId}:${index}`,
            kind: 'tool',
            name: '__reserve',
            status: 'running',
            startedAt: now,
            epoch,
          }),
        );
      }
      return indices;
    });
  }

  async *listRuns(filter: RunFilter): AsyncIterable<RunRef> {
    this.ensureTables();
    const clauses: Clause[] = [];
    if (filter.status !== undefined) {
      clauses.push({ sql: 'status = ', value: filter.status });
    }
    if (filter.kind === 'conversation') {
      clauses.push({ sql: `(kind IS NULL OR kind = 'conversation')` });
    } else if (filter.kind === 'flow') {
      clauses.push({ sql: `kind = 'flow'` });
    }
    if (filter.flowName !== undefined) {
      clauses.push({ sql: 'flow_name = ', value: filter.flowName });
    }
    if (filter.waitingSignalId !== undefined) {
      clauses.push({
        sql: `json_extract(state, '$.waitingFor.requestId') = `,
        value: filter.waitingSignalId,
      });
    }
    if (filter.deadlineBefore !== undefined) {
      clauses.push({
        sql: `(json_extract(state, '$.waitingFor.deadline') IS NOT NULL AND json_extract(state, '$.waitingFor.deadline') < `,
        value: filter.deadlineBefore.getTime(),
        tail: ')',
      });
    }

    const rows =
      clauses.length === 0
        ? this.sql<{ session_id: string; state: string }>`
            SELECT session_id, state FROM kuralle_run_state ORDER BY updated_at ASC
          `
        : this.selectFiltered(clauses);

    for (const row of rows) {
      yield cloneJson(toRunRef(parseJson<RunState>(row.state), row.session_id));
    }
  }

  async deleteRun(runId: string, options?: DeleteRunOptions): Promise<void> {
    this.ensureTables();
    await this.withTransaction(() => {
      const existing = this.sql<{ status: RunState['status'] }>`
        SELECT status FROM kuralle_run_state WHERE run_id = ${runId}
      `;
      const row = existing[0];
      if (!row) {
        throw new RunNotFoundError(runId);
      }
      if (!isTerminalRunStatus(row.status) && !options?.force) {
        throw new RunNotTerminalError(runId, row.status);
      }
      this.sql`DELETE FROM kuralle_run_steps WHERE run_id = ${runId}`;
      this.sql`DELETE FROM kuralle_run_state WHERE run_id = ${runId}`;
    });
  }

  /**
   * Copy a pre-SqlRunStore journal from the orchestration blob into the two
   * tables, skipping any run_id that already has a SQL row. Called once per
   * wake so a session journaled before this store existed can resume; later
   * saves stop writing `durableRuns` so the blob is not a second source of truth.
   */
  async importLegacyRuns(runs: SessionDurableRuns): Promise<void> {
    this.ensureTables();
    for (const persisted of Object.values(runs)) {
      if (!persisted?.runState?.runId) continue;
      if (await this.getRunState(persisted.runState.runId)) continue;
      await this.initRun(persisted.runState);
      for (const step of persisted.steps ?? []) {
        await this.appendStep(persisted.runState.runId, step);
      }
    }
  }

  private ensureTables(): void {
    if (this.initialized) return;
    this.sql`PRAGMA foreign_keys = ON`;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_run_state (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT,
        status TEXT NOT NULL,
        flow_name TEXT,
        state TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS kuralle_run_state_status_kind_idx
      ON kuralle_run_state (status, kind)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS kuralle_run_state_deadline_idx
      ON kuralle_run_state (json_extract(state, '$.waitingFor.deadline'))
      WHERE json_extract(state, '$.waitingFor.deadline') IS NOT NULL
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_run_steps (
        run_id TEXT NOT NULL REFERENCES kuralle_run_state (run_id) ON DELETE CASCADE,
        "index" INTEGER NOT NULL,
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT,
        result TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        epoch INTEGER,
        signal_id TEXT,
        interrupt_decision TEXT,
        PRIMARY KEY (run_id, "index")
      )
    `;
    this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS kuralle_run_steps_run_key_idx
      ON kuralle_run_steps (run_id, key)
    `;
    this.initialized = true;
  }

  private selectFiltered(clauses: Clause[]): Array<{ session_id: string; state: string }> {
    const { strings, values } = this.whereClauses(
      'SELECT session_id, state FROM kuralle_run_state WHERE ',
      clauses,
      ' ORDER BY updated_at ASC',
    );
    return this.sql<{ session_id: string; state: string }>(strings, ...values);
  }

  private whereClauses(
    prefix: string,
    clauses: Clause[],
    suffix: string,
  ): { strings: TemplateStringsArray; values: unknown[] } {
    const chunks: string[] = [];
    const values: unknown[] = [];
    let current = prefix;
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i]!;
      if (i > 0) current += ' AND ';
      current += clause.sql;
      if ('value' in clause) {
        chunks.push(current);
        values.push(clause.value);
        current = clause.tail ?? '';
      } else if (clause.tail) {
        current += clause.tail;
      }
    }
    current += suffix;
    chunks.push(current);
    return { strings: tagged(chunks), values };
  }

  private async withTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      this.sql`BEGIN`;
    } catch {
      // DO SQLite forbids SQL BEGIN; the request's storage writes are already atomic.
      return await fn();
    }
    try {
      const result = await fn();
      this.sql`COMMIT`;
      return result;
    } catch (error) {
      try {
        this.sql`ROLLBACK`;
      } catch {
        /* the original error is the one to surface */
      }
      throw error;
    }
  }

  private async stepCount(runId: string): Promise<number> {
    const result = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM kuralle_run_steps WHERE run_id = ${runId}
    `;
    return asNumber(result[0]?.n ?? 0);
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

  private insertStep(params: unknown[]): void {
    const [
      runId, index, key, kind, name, status, result, error,
      startedAt, finishedAt, epoch, signalId, interruptDecision,
    ] = params;
    this.sql`
      INSERT INTO kuralle_run_steps (
        run_id, "index", key, kind, name, status, result, error,
        started_at, finished_at, epoch, signal_id, interrupt_decision
      ) VALUES (
        ${runId}, ${index}, ${key}, ${kind}, ${name}, ${status}, ${result}, ${error},
        ${startedAt}, ${finishedAt}, ${epoch}, ${signalId}, ${interruptDecision}
      )
    `;
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
