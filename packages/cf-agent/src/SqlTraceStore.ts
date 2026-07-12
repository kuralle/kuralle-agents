import type { AgentSpan, AgentTrace, TraceListWindow, TraceStore } from '@kuralle-agents/core';
import { traceFromSpans } from '@kuralle-agents/core/tracing';
import type { SqlExecutor } from './types.js';

type TraceRow = { trace_id: string; payload: string };

export class SqlTraceStore implements TraceStore {
  constructor(private readonly sql: SqlExecutor) {
    this.sql`CREATE TABLE IF NOT EXISTS kuralle_trace_spans (
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (trace_id, span_id)
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS kuralle_trace_session_started_idx
      ON kuralle_trace_spans (session_id, started_at DESC)`;
  }

  write(span: AgentSpan): void { this.putSpan(span); }

  putSpan(span: AgentSpan): void {
    this.sql`INSERT INTO kuralle_trace_spans (trace_id, span_id, session_id, started_at, payload)
      VALUES (${span.traceId}, ${span.spanId}, ${span.attributes.sessionId}, ${span.startTime}, ${JSON.stringify(span)})
      ON CONFLICT(trace_id, span_id) DO UPDATE SET
        session_id = excluded.session_id, started_at = excluded.started_at, payload = excluded.payload`;
  }

  async getTrace(traceId: string): Promise<AgentTrace | null> {
    const rows = this.sql<TraceRow>`SELECT trace_id, payload FROM kuralle_trace_spans
      WHERE trace_id = ${traceId} ORDER BY started_at ASC`;
    return traceFromSpans(rows.map((row) => JSON.parse(row.payload) as AgentSpan));
  }

  async listTraces(sessionId: string, window?: TraceListWindow): Promise<AgentTrace[]> {
    const from = window?.from?.getTime() ?? 0;
    const to = window?.to?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const limit = window?.limit ?? 100;
    const rows = this.sql<TraceRow>`SELECT trace_id, MIN(started_at) AS started_at
      FROM kuralle_trace_spans WHERE session_id = ${sessionId}
      GROUP BY trace_id HAVING MIN(started_at) >= ${from} AND MIN(started_at) <= ${to}
      ORDER BY started_at DESC LIMIT ${limit}`;
    const traces = await Promise.all(rows.map((row) => this.getTrace(row.trace_id)));
    return traces.filter((trace): trace is AgentTrace => trace !== null);
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM (
      SELECT trace_id FROM kuralle_trace_spans GROUP BY trace_id HAVING MIN(started_at) < ${cutoff}
    )`[0]?.count ?? 0;
    this.sql`DELETE FROM kuralle_trace_spans WHERE trace_id IN (
      SELECT trace_id FROM kuralle_trace_spans GROUP BY trace_id HAVING MIN(started_at) < ${cutoff}
    )`;
    return Number(before);
  }
}
