import type { AgentSpan, AgentTrace, TraceListWindow, TraceStore } from '@kuralle-agents/core';
import { traceFromSpans } from '@kuralle-agents/core/tracing';
import type { QueryResult } from 'pg';

type PostgresClient = { query: (text: string, params?: unknown[]) => Promise<QueryResult> };

export interface PostgresTraceStoreOptions {
  client: PostgresClient;
  tableName?: string;
  autoMigrate?: boolean;
  retentionMs?: number;
}

export class PostgresTraceStore implements TraceStore {
  private readonly table: string;
  private readonly ready: Promise<void>;

  constructor(private readonly options: PostgresTraceStoreOptions) {
    this.table = normalizeTableName(options.tableName ?? 'kuralle_trace_spans');
    this.ready = options.autoMigrate === false ? Promise.resolve() : this.init();
  }

  write(span: AgentSpan): Promise<void> { return this.putSpan(span); }

  async putSpan(span: AgentSpan): Promise<void> {
    await this.ready;
    await this.options.client.query(
      `INSERT INTO ${this.table} (trace_id, span_id, session_id, started_at, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (trace_id, span_id) DO UPDATE SET payload = EXCLUDED.payload, started_at = EXCLUDED.started_at`,
      [span.traceId, span.spanId, span.attributes.sessionId, new Date(span.startTime), JSON.stringify(span)],
    );
    if (this.options.retentionMs !== undefined) await this.cleanup(this.options.retentionMs);
  }

  async getTrace(traceId: string): Promise<AgentTrace | null> {
    await this.ready;
    const result = await this.options.client.query(
      `SELECT payload FROM ${this.table} WHERE trace_id = $1 ORDER BY started_at ASC`, [traceId],
    );
    return traceFromSpans(result.rows.map(parseSpan));
  }

  async listTraces(sessionId: string, window?: TraceListWindow): Promise<AgentTrace[]> {
    await this.ready;
    const params: unknown[] = [sessionId];
    const having: string[] = [];
    if (window?.from) { params.push(window.from); having.push(`MIN(started_at) >= $${params.length}`); }
    if (window?.to) { params.push(window.to); having.push(`MIN(started_at) <= $${params.length}`); }
    params.push(window?.limit ?? 100);
    const ids = await this.options.client.query(
      `SELECT trace_id, MIN(started_at) AS trace_started_at FROM ${this.table}
       WHERE session_id = $1 GROUP BY trace_id ${having.length > 0 ? `HAVING ${having.join(' AND ')}` : ''}
       ORDER BY trace_started_at DESC LIMIT $${params.length}`,
      params,
    );
    const traces = await Promise.all(ids.rows.map((row) => this.getTrace(String(row.trace_id))));
    return traces.filter((trace): trace is AgentTrace => trace !== null);
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    await this.ready;
    const result = await this.options.client.query(
      `DELETE FROM ${this.table} WHERE trace_id IN (
        SELECT trace_id FROM ${this.table} GROUP BY trace_id HAVING MIN(started_at) < $1
      )`,
      [new Date(Date.now() - maxAgeMs)],
    );
    return result.rowCount ?? 0;
  }

  private async init(): Promise<void> {
    await this.options.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        trace_id TEXT NOT NULL, span_id TEXT NOT NULL, session_id TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL,
        PRIMARY KEY (trace_id, span_id)
      )`,
    );
    await this.options.client.query(
      `CREATE INDEX IF NOT EXISTS ${this.table.replace(/\./g, '_')}_session_started_idx
       ON ${this.table} (session_id, started_at DESC)`,
    );
  }
}

function normalizeTableName(table: string): string {
  if (!/^[a-zA-Z0-9_.]+$/.test(table)) throw new Error(`Invalid table name: ${table}`);
  return table;
}

function parseSpan(row: { payload?: unknown }): AgentSpan {
  return (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as AgentSpan;
}
