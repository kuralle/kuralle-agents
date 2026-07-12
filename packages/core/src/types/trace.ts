export type SpanKind = 'turn' | 'flow' | 'node' | 'tool' | 'handoff' | 'llm';

export interface AgentSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  status: 'ok' | 'error';
  events?: Array<{ name: string; time: number; attributes?: Record<string, unknown> }>;
  attributes: {
    sessionId: string;
    activeFlow?: string;
    nodeId?: string;
    toolName?: string;
    handoffFrom?: string;
    handoffTo?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
    /** Prompt/context tokens for this turn (the context-window size in flight). */
    tokensIn?: number;
    /** Generated tokens for this turn. */
    tokensOut?: number;
  };
}

export interface AgentTrace {
  traceId: string;
  sessionId: string;
  spans: AgentSpan[];
  answer: string;
  usedTool: boolean;
  toolCalls: Array<{ name: string; args: unknown }>;
  toolResults: Array<{ name: string; result: unknown }>;
  startedAt: number;
  endedAt?: number;
}
