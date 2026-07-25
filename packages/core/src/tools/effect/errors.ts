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

/** Thrown when a human denies a tool call that requires approval. */
export class ToolApprovalDeniedError extends Error {
  readonly toolName: string;
  readonly by?: string;

  constructor(toolName: string, by?: string) {
    super(`Tool "${toolName}" was denied approval${by ? ` by ${by}` : ''}`);
    this.name = 'ToolApprovalDeniedError';
    this.toolName = toolName;
    this.by = by;
  }
}
