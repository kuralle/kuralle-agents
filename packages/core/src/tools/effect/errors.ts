/** Thrown when a tool execution exceeds its configured timeout. */
export class ToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timeout after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown by a tool's `execute` (or a guard wrapping it) when the call failed for a
 * reason the model can correct: a referent that does not exist ("Unknown unit '12B'"),
 * a value out of range, a missing precondition the user can supply. Distinct from a
 * fatal fault (network down, schema broken) in that the model should see the message
 * and retry — not be told "something went wrong on my side".
 *
 * On the model path it is returned to the model as a tool result (the model self-corrects).
 * On the flow path it is the signal to re-collect the offending input instead of
 * degrading the flow — see `runFlow`. Detected by type (`isRecoverableToolError`), never
 * by string-matching the message.
 */
export class RecoverableToolError extends Error {
  /**
   * Author-written copy shown to the USER, verbatim, when a flow re-asks after this
   * error. `message` is for the model; a business rejection ("that unit already has
   * an open work order") is useless to the person unless someone tells them, and the
   * collect node's `ask` is deterministic precisely so the model cannot rephrase it.
   */
  readonly userMessage?: string;

  constructor(message: string, options?: { userMessage?: string }) {
    super(message);
    this.name = 'RecoverableToolError';
    if (options?.userMessage !== undefined) {
      this.userMessage = options.userMessage;
    }
  }
}

/** Thrown when a human denies a tool call that requires approval. */
export class ToolApprovalDeniedError extends Error {
  readonly toolName: string;
  readonly by?: string;
  /** Why, when a policy refused. Human denials carry no reason — the human just said no. */
  readonly reason?: string;

  constructor(toolName: string, by?: string, reason?: string) {
    super(
      `Tool "${toolName}" was denied approval${by ? ` by ${by}` : ''}${reason ? `: ${reason}` : ''}`,
    );
    this.name = 'ToolApprovalDeniedError';
    this.toolName = toolName;
    this.by = by;
    this.reason = reason;
  }
}
