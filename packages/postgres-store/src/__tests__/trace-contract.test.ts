import { runTraceStoreContract } from '@kuralle-agents/core/tracing/testing';
import { PostgresTraceStore } from '../PostgresTraceStore.js';

type Row = {
  trace_id: string;
  span_id: string;
  session_id: string;
  started_at: Date;
  payload: string;
};

function createClient() {
  const rows: Row[] = [];
  return {
    async query(text: string, params: unknown[] = []) {
      const sql = text.trim();
      if (sql.startsWith('CREATE')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('INSERT')) {
        const [traceId, spanId, sessionId, startedAt, payload] = params as [string, string, string, Date, string];
        const next = { trace_id: traceId, span_id: spanId, session_id: sessionId, started_at: startedAt, payload };
        const index = rows.findIndex((row) => row.trace_id === traceId && row.span_id === spanId);
        if (index >= 0) rows[index] = next; else rows.push(next);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT payload')) {
        const selected = rows.filter((row) => row.trace_id === params[0]);
        return { rows: selected.sort((a, b) => +a.started_at - +b.started_at).map((row) => ({ payload: row.payload })), rowCount: selected.length };
      }
      if (sql.startsWith('SELECT trace_id')) {
        const [sessionId] = params as [string];
        let selected = rows.filter((row) => row.session_id === sessionId);
        const dates = params.filter((value) => value instanceof Date) as Date[];
        if (sql.includes('started_at >=') && dates[0]) selected = selected.filter((row) => row.started_at >= dates[0]!);
        if (sql.includes('started_at <=') && dates.at(-1)) selected = selected.filter((row) => row.started_at <= dates.at(-1)!);
        const byTrace = new Map<string, Date>();
        for (const row of selected) {
          const current = byTrace.get(row.trace_id);
          if (!current || row.started_at < current) byTrace.set(row.trace_id, row.started_at);
        }
        const limit = Number(params.at(-1));
        const result = [...byTrace].sort((a, b) => +b[1] - +a[1]).slice(0, limit)
          .map(([trace_id, trace_started_at]) => ({ trace_id, trace_started_at }));
        return { rows: result, rowCount: result.length };
      }
      if (sql.startsWith('DELETE')) return { rows: [], rowCount: 0 };
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  };
}

runTraceStoreContract(() => new PostgresTraceStore({ client: createClient() as never }));
