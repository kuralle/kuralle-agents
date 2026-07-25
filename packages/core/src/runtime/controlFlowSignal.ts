import { SuspendError } from './durable/RunStore.js';
import { ToolApprovalDeniedError } from '../tools/effect/errors.js';

/**
 * A control-flow signal unwinds the stack like an error but is not a failure: the run is
 * pausing for a human, or a human answered "no". It must never be reported to the model as
 * a tool error, shown to the user as an error, or journaled as one.
 *
 * Every `catch` that turns an exception into a tool result has to consult this first.
 * `runFlow` did; the model-issued tool path did not, so a `needsApproval` tool told the
 * model "Run suspended waiting for __approval" as a tool failure and kept generating while
 * the store said the run was paused. One predicate, so the two paths cannot disagree again.
 */
export function isControlFlowSignal(error: unknown): boolean {
  return error instanceof SuspendError || error instanceof ToolApprovalDeniedError;
}
