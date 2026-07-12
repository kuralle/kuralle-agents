/**
 * A tiny JSONL-file-backed TraceStore so `kuralle chat --trace --store <file>`
 * accumulates traces across launches (dev only). Spans are APPENDED one-per-line
 * — O(1) per write, no full-file rewrite — and reconstructed on read (last write
 * wins per spanId). Production trace stores live in @kuralle-agents/{redis,postgres}-store
 * and @kuralle-agents/cf-agent.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentSpan, AgentTrace, TraceListWindow, TraceStore } from '@kuralle-agents/core';
import { traceFromSpans } from '@kuralle-agents/core/tracing';

export function fileTraceStore(path: string): TraceStore {
  let dirReady = false;

  const putSpan = (span: AgentSpan): void => {
    if (!dirReady) {
      mkdirSync(dirname(path), { recursive: true });
      dirReady = true;
    }
    appendFileSync(path, `${JSON.stringify(span)}\n`);
  };

  const readByTrace = (): Map<string, Map<string, AgentSpan>> => {
    const byTrace = new Map<string, Map<string, AgentSpan>>();
    if (!existsSync(path)) return byTrace;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const span = JSON.parse(line) as AgentSpan;
        let spans = byTrace.get(span.traceId);
        if (!spans) {
          spans = new Map();
          byTrace.set(span.traceId, spans);
        }
        spans.set(span.spanId, span); // last write wins (span updates)
      } catch {
        // skip a torn/partial line rather than fail the read
      }
    }
    return byTrace;
  };

  return {
    write: putSpan,
    putSpan,
    async getTrace(traceId: string): Promise<AgentTrace | null> {
      return traceFromSpans([...(readByTrace().get(traceId)?.values() ?? [])]);
    },
    async listTraces(sessionId: string, window?: TraceListWindow): Promise<AgentTrace[]> {
      const traces = [...readByTrace().values()]
        .map((spans) => traceFromSpans([...spans.values()]))
        .filter((t): t is AgentTrace => t !== null && t.sessionId === sessionId)
        .sort((a, b) => b.startedAt - a.startedAt);
      return window?.limit === undefined ? traces : traces.slice(0, window.limit);
    },
  };
}
