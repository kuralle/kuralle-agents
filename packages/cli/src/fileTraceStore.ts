/**
 * A tiny JSON-file-backed TraceStore so `kuralle chat --trace --store <file>`
 * accumulates traces across launches (dev only). Mirrors fileStore.ts for
 * sessions. Production trace stores live in @kuralle-agents/{redis,postgres}-store
 * and @kuralle-agents/cf-agent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentSpan, AgentTrace, TraceListWindow, TraceStore } from '@kuralle-agents/core';
import { traceFromSpans } from '@kuralle-agents/core/tracing';

/** traceId → spanId → span */
type Persisted = Record<string, Record<string, AgentSpan>>;

export function fileTraceStore(path: string): TraceStore {
  const read = (): Persisted => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Persisted) : {};
    } catch {
      return {};
    }
  };
  const flush = (data: Persisted): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  };
  const putSpan = (span: AgentSpan): void => {
    const data = read();
    (data[span.traceId] ??= {})[span.spanId] = span;
    flush(data);
  };
  return {
    write: putSpan,
    putSpan,
    async getTrace(traceId: string): Promise<AgentTrace | null> {
      return traceFromSpans(Object.values(read()[traceId] ?? {}));
    },
    async listTraces(sessionId: string, window?: TraceListWindow): Promise<AgentTrace[]> {
      const traces = Object.values(read())
        .map((spans) => traceFromSpans(Object.values(spans)))
        .filter((t): t is AgentTrace => t !== null && t.sessionId === sessionId)
        .sort((a, b) => b.startedAt - a.startedAt);
      return window?.limit === undefined ? traces : traces.slice(0, window.limit);
    },
  };
}
