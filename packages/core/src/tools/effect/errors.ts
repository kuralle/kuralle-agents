/**
 * Thrown by `ctx.tool(...)` when a tool declared `needsApproval: true` is denied
 * by a human (the `__approval` signal resolves with `approved: false`). Catch it
 * inside the calling flow `action` node to route gracefully (e.g. escalate or end).
 */
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
