import { runTraceStoreContract } from '@kuralle-agents/core/tracing/testing';
import type { AgentSpan } from '@kuralle-agents/core';
import { SqlTraceStore } from '../SqlTraceStore.js';
import type { SqlExecutor } from '../types.js';

function createSql(): SqlExecutor {
  const rows = new Map<string, AgentSpan>();
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    if (query.startsWith('CREATE')) return [];
    if (query.startsWith('INSERT')) {
      const span = JSON.parse(String(values[4])) as AgentSpan;
      rows.set(`${span.traceId}:${span.spanId}`, span);
      return [];
    }
    if (query.includes('WHERE trace_id =')) {
      return [...rows.values()].filter((span) => span.traceId === values[0])
        .sort((a, b) => a.startTime - b.startTime)
        .map((span) => ({ trace_id: span.traceId, payload: JSON.stringify(span) }));
    }
    if (query.startsWith('SELECT trace_id')) {
      const [sessionId, from, to, limit] = values as [string, number, number, number];
      const traces = new Map<string, number>();
      for (const span of rows.values()) {
        if (span.attributes.sessionId !== sessionId || span.startTime < from || span.startTime > to) continue;
        traces.set(span.traceId, Math.min(traces.get(span.traceId) ?? Infinity, span.startTime));
      }
      return [...traces].sort((a, b) => b[1] - a[1]).slice(0, limit)
        .map(([trace_id, started_at]) => ({ trace_id, started_at }));
    }
    if (query.startsWith('SELECT COUNT')) return [{ count: 0 }];
    if (query.startsWith('DELETE')) return [];
    throw new Error(`Unhandled SQL: ${query}`);
  }) as SqlExecutor;
}

runTraceStoreContract(() => new SqlTraceStore(createSql()));
