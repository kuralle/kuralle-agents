/**
 * Event + config types for the Kuralle Analytics SDK.
 *
 * Zod schemas live here too — every event goes through `AnalyticsEventSchema`
 * before being enqueued so bad data (missing workspace, bad timestamp) fails
 * loudly at the caller rather than silently on the wire.
 */

import { z } from "zod";

export type AnalyticsEventType =
  | "conversation.started"
  | "conversation.ended"
  | "node.entered"
  | "node.exited"
  | "tool.called"
  | "tool.completed"
  | "tool.error"
  | "booking.completed"
  | "handoff.initiated"
  | "emergency.detected"
  | "call.started"
  | "call.ended"
  | "user.spoke"
  | "agent.spoke"
  | "user.interrupted"
  | "silence.detected"
  | "latency.stt"
  | "latency.ttf"
  | "latency.e2e"
  | "latency.tts"
  | "error.occurred"
  | "custom";

export interface AnalyticsEvent {
  id?: string;
  timestamp?: Date;
  sessionId: string;
  conversationId?: string;
  agentId: string;
  workspaceId: string;
  type: AnalyticsEventType;
  data: Record<string, unknown>;
}

export interface VoiceCallData {
  sessionId: string;
  workspaceId: string;
  agentId?: string;
  userName?: string;
  userId?: string;
  startedAt: Date;
  endedAt?: Date;
  durationSeconds?: number;
  userTurns?: number;
  agentTurns?: number;
  interruptions?: number;
  silenceEvents?: number;
  errors?: number;
  totalUserSpeechMs?: number;
  totalAgentSpeechMs?: number;
  totalSilenceMs?: number;
  ttfMs?: number;
  avgSttMs?: number;
  avgTtsMs?: number;
  e2eMs?: number;
  outcome?: string;
  outcomeData?: Record<string, unknown>;
  currentNode?: string;
  agentName?: string;
  transcript?: string;
  metadata?: Record<string, unknown>;
}

export interface AnalyticsConfig {
  apiKey: string;
  endpoint?: string;
  workspaceId: string;
  flushInterval?: number;
  maxBatchSize?: number;
  enableDebug?: boolean;
  /**
   * Base delay (ms) for exponential backoff between failed-batch retries.
   * Default: 500ms. Attempt N waits `baseDelayMs * 2^(N-1)`, capped at
   * `maxDelayMs`.
   */
  retryBaseDelayMs?: number;
  /** Ceiling on exponential-backoff delay (ms). Default: 30_000. */
  retryMaxDelayMs?: number;
  /** Maximum retries per batch before dropping. Default: 5. */
  retryMaxAttempts?: number;
}

export interface AnalyticsContext {
  workspaceId: string;
  agentId?: string;
  sessionId?: string;
  userId?: string;
  conversationId?: string;
}

const AnalyticsEventTypeSchema = z.enum([
  "conversation.started",
  "conversation.ended",
  "node.entered",
  "node.exited",
  "tool.called",
  "tool.completed",
  "tool.error",
  "booking.completed",
  "handoff.initiated",
  "emergency.detected",
  "call.started",
  "call.ended",
  "user.spoke",
  "agent.spoke",
  "user.interrupted",
  "silence.detected",
  "latency.stt",
  "latency.ttf",
  "latency.e2e",
  "latency.tts",
  "error.occurred",
  "custom",
]);

/**
 * Zod schema for inbound events. Enforces required fields + restricted type
 * enum. `data` is free-form on purpose.
 */
export const AnalyticsEventSchema = z.object({
  id: z.string().optional(),
  timestamp: z.date().optional(),
  sessionId: z.string().min(1, "sessionId is required"),
  conversationId: z.string().optional(),
  agentId: z.string(),
  workspaceId: z.string().min(1, "workspaceId is required"),
  type: AnalyticsEventTypeSchema,
  data: z.record(z.unknown()),
});

/** Throws on invalid event. Use to fail loud at the caller. */
export function validateAnalyticsEvent(event: unknown): AnalyticsEvent {
  return AnalyticsEventSchema.parse(event) as AnalyticsEvent;
}

export interface AnalyticsClient {
  track: (event: AnalyticsEvent) => Promise<void>;
  trackBatch: (events: AnalyticsEvent[]) => Promise<void>;
  trackVoiceCall: (data: VoiceCallData) => Promise<void>;
  updateVoiceCall: (sessionId: string, data: Partial<VoiceCallData>) => Promise<void>;
  flush: () => Promise<void>;
  setContext: (context: Partial<AnalyticsContext>) => void;
  identify: (userId: string, traits?: Record<string, unknown>) => void;
}
