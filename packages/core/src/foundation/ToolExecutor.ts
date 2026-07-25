import type { Session, ToolCallRecord } from '../types/index.js';

/**
 * Minimal tool shape required by the executor.
 * Compatible with AI SDK `Tool` and plain `{ execute }` objects.
 */
export interface ExecutableTool {
  execute: (args: unknown, options?: unknown) => Promise<unknown>;
  description?: string;
}

/**
 * Encapsulates tool execution with enforcement, idempotency, and context enrichment.
 * Used by Runtime.
 */
export interface ToolExecutor {
  /**
   * Execute a single tool call with enforcement checks and context enrichment.
   * Returns the tool's result or throws if blocked/failed.
   */
  execute(args: {
    session: Session;
    userId?: string;
    agentId: string;
    toolName: string;
    tool: ExecutableTool;
    input: unknown;
    toolCallId?: string;
    abortSignal?: AbortSignal;
    step?: number;
    turn?: number;
    /** Full tool call history for enforcement context. */
    toolCallHistory?: ToolCallRecord[];
  }): Promise<unknown>;

  /**
   * Build a deterministic idempotency key for external side-effect deduplication.
   */
  buildIdempotencyKey(args: {
    sessionId: string;
    agentId: string;
    step: number;
    toolName: string;
    toolCallId: string;
  }): string;
}
