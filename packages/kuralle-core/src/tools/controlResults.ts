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
