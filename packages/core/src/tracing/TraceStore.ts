import type { AgentSpan, AgentTrace } from '../types/trace.js';

export interface TraceListWindow {
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface TraceSink {
  write(span: AgentSpan): void | Promise<void>;
  flush?(): Promise<void>;
}

export interface TraceStore extends TraceSink {
  putSpan(span: AgentSpan): void | Promise<void>;
  getTrace(traceId: string): Promise<AgentTrace | null>;
  listTraces(sessionId: string, window?: TraceListWindow): Promise<AgentTrace[]>;
  cleanup?(maxAgeMs: number): Promise<number>;
}

export function isTraceStore(sink: TraceSink): sink is TraceStore {
  const value = sink as Partial<TraceStore>;
  return typeof value.putSpan === 'function' &&
    typeof value.getTrace === 'function' &&
    typeof value.listTraces === 'function';
}

export function traceFromSpans(spans: AgentSpan[]): AgentTrace | null {
  if (spans.length === 0) return null;
  const ordered = spans.map(cloneSpan).sort((a, b) => a.startTime - b.startTime);
  const root = ordered.find((span) => span.kind === 'turn') ?? ordered[0]!;
  const tools = ordered.filter((span) => span.kind === 'tool');
  return {
    traceId: root.traceId,
    sessionId: root.attributes.sessionId,
    spans: ordered,
    answer: typeof root.attributes.output === 'string' ? root.attributes.output : '',
    usedTool: tools.length > 0,
    toolCalls: tools.map((span) => ({
      name: span.attributes.toolName ?? span.name,
      args: span.attributes.input ?? null,
    })),
    toolResults: tools
      .filter((span) => span.attributes.output !== undefined)
      .map((span) => ({ name: span.attributes.toolName ?? span.name, result: span.attributes.output })),
    startedAt: root.startTime,
    ...(root.endTime !== undefined ? { endedAt: root.endTime } : {}),
  };
}

export function cloneSpan(span: AgentSpan): AgentSpan {
  return structuredClone(span);
}
