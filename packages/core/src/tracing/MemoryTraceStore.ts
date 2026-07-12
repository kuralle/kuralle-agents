import type { AgentSpan, AgentTrace } from '../types/trace.js';
import {
  cloneSpan,
  traceFromSpans,
  type TraceListWindow,
  type TraceStore,
} from './TraceStore.js';

export interface MemoryTraceStoreOptions {
  retentionMs?: number;
}

export class MemoryTraceStore implements TraceStore {
  private readonly spans = new Map<string, Map<string, AgentSpan>>();

  constructor(private readonly options: MemoryTraceStoreOptions = {}) {}

  write(span: AgentSpan): void {
    this.putSpan(span);
  }

  putSpan(span: AgentSpan): void {
    let trace = this.spans.get(span.traceId);
    if (!trace) {
      trace = new Map();
      this.spans.set(span.traceId, trace);
    }
    trace.set(span.spanId, cloneSpan(span));
    if (this.options.retentionMs !== undefined) this.cleanupSync(this.options.retentionMs);
  }

  async getTrace(traceId: string): Promise<AgentTrace | null> {
    const spans = this.spans.get(traceId);
    return traceFromSpans(spans ? [...spans.values()] : []);
  }

  async listTraces(sessionId: string, window?: TraceListWindow): Promise<AgentTrace[]> {
    const traces = [...this.spans.values()]
      .map((spans) => traceFromSpans([...spans.values()]))
      .filter((trace): trace is AgentTrace => trace !== null)
      .filter((trace) => trace.sessionId === sessionId)
      .filter((trace) => inWindow(trace.startedAt, window))
      .sort((a, b) => b.startedAt - a.startedAt);
    return window?.limit === undefined ? traces : traces.slice(0, window.limit);
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    return this.cleanupSync(maxAgeMs);
  }

  private cleanupSync(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [traceId, spans] of this.spans) {
      const root = [...spans.values()].find((span) => span.kind === 'turn');
      if ((root?.endTime ?? root?.startTime ?? 0) < cutoff) {
        this.spans.delete(traceId);
        removed += 1;
      }
    }
    return removed;
  }
}

function inWindow(timestamp: number, window?: TraceListWindow): boolean {
  if (window?.from && timestamp < window.from.getTime()) return false;
  if (window?.to && timestamp > window.to.getTime()) return false;
  return true;
}
