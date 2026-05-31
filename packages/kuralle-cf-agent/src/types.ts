import type { HarnessConfig, HarnessHooks, Session } from '@kuralle-agents/core';

/**
 * SQL executor type matching Cloudflare's Durable Object sql binding.
 *
 * Returns rows directly as an array — NOT an object with `.toArray()`. This
 * was a long-standing type bug that surfaced today when the voice path
 * started routing through `OrchestrationStore.get()`: SQL returned an array
 * but code called `.toArray()` on it, throwing `TypeError`.
 *
 * Verified against the `cloudflare/agents` base class at
 * `packages/agents/src/index.ts:881-888` — `const result = this.sql...`
 * followed by `result.length`/`result[0]` with no `.toArray()` anywhere.
 */
export type SqlExecutor = <T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => T[];

/**
 * Orchestration state persisted separately from CF messages.
 * This is everything Kuralle needs beyond message history --
 * CF owns messages, Kuralle owns agent state.
 */
export interface OrchestrationState {
  currentAgent: string;
  workingMemory: Record<string, unknown>;
  agentStates: Record<string, unknown>;
  handoffHistory: Array<{
    from: string;
    to: string;
    reason: string;
    timestamp: string;
  }>;
  state?: Record<string, unknown>;
}

/**
 * Configuration for the stream adapter.
 * Controls which Kuralle events are forwarded to CF as data parts.
 */
export interface StreamAdapterConfig {
  /** Include handoff events as data-handoff parts. Default: true. */
  includeHandoffs: boolean;
  /** Include flow node/transition events as data-flow-* parts. Default: false. */
  includeFlowEvents: boolean;
  /** Include tripwire events as data-tripwire parts. Default: false. */
  includeTripwires: boolean;
  /** Include tool call arguments in tool-input-available. Default: false. */
  includeToolArgs: boolean;
}

export const DEFAULT_STREAM_CONFIG: StreamAdapterConfig = {
  includeHandoffs: true,
  includeFlowEvents: false,
  includeTripwires: false,
  includeToolArgs: false,
};
