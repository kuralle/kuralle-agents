import type { RunState, StepRecord } from './types.js';

/**
 * Current effect-key scheme. Version 1 puts the active flow in the key namespace.
 *
 * Before it, `resetCallsites()` rebased the effect ordinal to 0 on every flow entry and
 * the key carried no flow, so two flows in one logical run that called a same-named tool
 * with the same arguments collided — the second replayed the first one's result.
 */
export const EFFECT_KEY_VERSION = 1;

/**
 * Refuse to resume a run whose journal predates the flow-scoped key scheme while it is
 * still inside a flow. Its recorded steps were keyed without the flow, so nothing would
 * match and every effect it already performed — a payment, a dispatch — would run again.
 *
 * Outside a flow the key is unchanged, and a run with nothing journaled has nothing to
 * mis-key; both resume normally and adopt the current scheme.
 */
export function assertResumableEffectKeys(run: RunState, steps: StepRecord[]): void {
  if (!run.activeFlow) return;
  if (steps.length === 0) return;
  if (run.effectKeyVersion === EFFECT_KEY_VERSION) return;
  throw new Error(
    `Run ${run.runId} was journaled under an older effect-key scheme and is still inside ` +
      `flow "${run.activeFlow}". Resuming it would re-execute effects it has already ` +
      `performed. Resolve this run out of band; it cannot be resumed safely.`,
  );
}
