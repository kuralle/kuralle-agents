/** Per-turn token usage for context window observability (cumulative fields filled by the runtime). */
export interface TurnUsage {
  turn: number;
  nodeId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeTotalTokens: number;
  /** Cumulative input vs model context window (0..1) when a window is configured. */
  contextUtilization?: number;
  model?: string;
  latencyMs: number;
}

/**
 * Events streamed to Kuralle Studio (or other live trace consumers) during a session.
 * Aligns with the studio WebSocket protocol; keep fields JSON-serializable.
 */
export type TraceStreamEvent =
  | { type: 'session:start'; sessionId: string; agentId: string; timestamp: number }
  | {
      type: 'span:start';
      spanId: string;
      parentId?: string;
      name: string;
      timestamp: number;
      attributes?: Record<string, unknown>;
    }
  | { type: 'span:end'; spanId: string; durationMs: number; status: 'success' | 'error' }
  | { type: 'tool:call'; toolName: string; args?: unknown; timestamp: number }
  | { type: 'tool:result'; toolName: string; durationMs: number; success: boolean }
  | { type: 'flow:transition'; from: string; to: string; timestamp: number }
  | { type: 'extraction:update'; nodeId: string; collected: Record<string, unknown>; missing: string[] }
  | {
      type: 'tokens:turn';
      sessionId: string;
      turn: number;
      nodeId?: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens?: number;
      cumulativeTotalTokens: number;
      contextUtilization?: number;
      model?: string;
    }
  | { type: 'session:end'; sessionId: string; success: boolean; durationMs: number };

export interface TracingConfig {
    serviceName: string;
    exporter?: (span: Span) => Promise<void>;
    sampleRate?: number;
}

export interface Span {
    id: string;
    parentId?: string;
    name: string;
    startTime: number;
    endTime?: number;
    attributes: Record<string, string | number | boolean>;
    events: SpanEvent[];
    status: 'started' | 'ended' | 'error';
    error?: Error;
}

export interface SpanEvent {
    name: string;
    timestamp: number;
    attributes?: Record<string, string | number | boolean>;
}

export interface MetricsConfig {
    prefix?: string;
    tags?: Record<string, string>;
}

export interface ObservabilityMetrics {
    increment(name: string, value?: number, tags?: Record<string, string>): void;
    gauge(name: string, value: number, tags?: Record<string, string>): void;
    histogram(name: string, value: number, tags?: Record<string, string>): void;
    timing(name: string, value: number, tags?: Record<string, string>): void;
    recordSpan(span: Span): void;
}

export interface Metrics {
    increment(name: string, value?: number, tags?: Record<string, string>): void;
    gauge(name: string, value: number, tags?: Record<string, string>): void;
    histogram(name: string, value: number, tags?: Record<string, string>): void;
    timing(name: string, value: number, tags?: Record<string, string>): void;
}

export interface SessionTelemetry {
    sessionId: string;
    agentId: string;
    startTime: Date;
    endTime?: Date;
    duration?: number;
    steps: number;
    tokens: number;
    toolCalls: number;
    errors: number;
    handoffs: number;
    success: boolean;
}

/** Metadata passed to `onSessionEnd` when a session is closed (e.g. authority.closeSession). */
export interface SessionEndMetadata {
    success: boolean;
    endReason?: string;
    durationMs?: number;
    turnCount?: number;
    lastAgentId?: string;
}

/**
 * Structured session trace emitted when the root session span ends.
 * Computed from spans and hook/stream state collected during the session.
 */
export interface SessionTrace {
    sessionId: string;
    agentId: string;
    startTime: number;
    endTime: number;
    durationMs: number;
    success: boolean;
    turnCount: number;
    toolCalls: Array<{ name: string; durationMs: number; success: boolean }>;
    flowTransitions: Array<{ from: string; to: string; timestamp: number }>;
    handoffs: Array<{ from: string; to: string; reason: string }>;
    extractionSubmissions: Array<{ node: string; fieldsAccepted: string[]; fieldsRejected: string[] }>;
    errors: Array<{ message: string; timestamp: number }>;
    latency: {
        avgTurnMs: number;
        p50TurnMs: number;
        p95TurnMs: number;
        firstResponseMs: number;
    };
    /** Voice-specific metrics; omitted when no voice activity was recorded. */
    voice?: {
        bargeInCount: number;
        reconfigureCount: number;
        totalAudioInBytes: number;
        totalAudioOutBytes: number;
        avgTimeToFirstAudioMs: number;
    };
    spans: Span[];
    /** Present when token observability recorded at least one LLM call. */
    totalInputTokens?: number;
    totalOutputTokens?: number;
    /** Session-level total tokens (provider-reported sums). */
    totalTokens?: number;
    totalCacheReadTokens?: number;
    peakContextUtilization?: number;
    perTurnUsage?: TurnUsage[];
}
