export interface EscalateResult {
  __escalate: true;
  reason: string;
}

export function isEscalateResult(result: unknown): result is EscalateResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    '__escalate' in result &&
    (result as { __escalate: unknown }).__escalate === true &&
    typeof (result as { reason?: unknown }).reason === 'string'
  );
}

export interface RecoverResult {
  __recover: true;
  reason?: string;
}

export function isRecoverResult(result: unknown): result is RecoverResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    '__recover' in result &&
    (result as { __recover: unknown }).__recover === true
  );
}

/** Standard tool-result shape when `ctx.tool` fails in a model-initiated call. */
export function toolErrorResult(error: unknown): { error: true; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { error: true, message };
}

export interface ToolDeniedResult {
  __denied: true;
  toolName: string;
  deniedBy?: string;
  message: string;
}

/**
 * What the model sees when a human declines a `needsApproval` tool it asked to run.
 *
 * A result rather than an error, so the agent can tell the user the request was declined
 * instead of the turn dying. `__denied` (not `error: true`) keeps it distinguishable from a
 * genuine failure — nothing malfunctioned.
 */
export function toolDeniedResult(toolName: string, deniedBy?: string): ToolDeniedResult {
  return {
    __denied: true,
    toolName,
    deniedBy,
    message: `The "${toolName}" action was not approved${deniedBy ? ` by ${deniedBy}` : ''}. Tell the user it was declined; do not retry it.`,
  };
}
