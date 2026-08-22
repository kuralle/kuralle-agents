/**
 * Map runtime input-validation failures to HTTP 400; everything else stays 500.
 *
 * Matches core's `name` tag rather than the message text (a reworded message would
 * silently revert the status to 500) and rather than `instanceof` (which fails when a
 * consumer resolves two copies of core).
 */
export function runInputErrorStatus(error: unknown): 400 | 500 {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'InvalidCallerMessagesError' ? 400 : 500;
}

export function runInputErrorBody(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}
