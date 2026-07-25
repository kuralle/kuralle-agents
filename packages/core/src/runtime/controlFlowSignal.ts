import { SuspendError } from './durable/RunStore.js';
import { ToolApprovalDeniedError } from '../tools/effect/errors.js';

/**
 * The run is not finished: stop the turn, keep the journal, resume when a signal arrives.
 * It unwinds the stack like an error but is not a failure, so it must never be reported to
 * the model as a tool error, shown to the user as an error, or journaled as one.
 *
 * Only `SuspendError` qualifies. An approval *denial* is deliberately not a signal — see
 * `isApprovalDenial`.
 */
export function isControlFlowSignal(error: unknown): boolean {
  return error instanceof SuspendError;
}

/**
 * A human answered "no". Neither a failure nor a suspend — the opposite of a suspend, in
 * fact: a suspend defers the decision, a denial resolves it.
 *
 * Two rules follow, and they differ by who is driving the call:
 *
 * - It must never be degraded into "something went wrong on my side". Nothing went wrong;
 *   saying so would be a lie to the user.
 * - On the **model** path it becomes a tool result, because there is no author code to
 *   catch it and the agent needs to be able to tell the user the request was declined.
 *   On the **flow** path it keeps propagating, because an `action` node's author chose to
 *   call the tool and can catch it or branch on `ctx.approve()` instead.
 */
export function isApprovalDenial(error: unknown): error is ToolApprovalDeniedError {
  return error instanceof ToolApprovalDeniedError;
}
