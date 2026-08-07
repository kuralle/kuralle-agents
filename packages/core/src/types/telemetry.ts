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
    /** Present when token observability recorded at least one LLM call. */
    totalInputTokens?: number;
    totalOutputTokens?: number;
    /** Session-level total tokens (provider-reported sums). */
    totalTokens?: number;
    totalCacheReadTokens?: number;
    peakContextUtilization?: number;
    perTurnUsage?: TurnUsage[];
}
