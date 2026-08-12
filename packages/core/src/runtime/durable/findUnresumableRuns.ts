import type { SessionStore } from '../../session/SessionStore.js';
import { readSessionDurableRuns } from './types.js';
import { EFFECT_KEY_VERSION } from './effectKeyVersion.js';

/** Why a persisted run will refuse to resume after upgrading. */
export type UnresumableReason =
  /** Paused on an approval created before approvals were request-bound. Its decision
   *  would otherwise be keyed by call order rather than by the operation it authorises. */
  | 'legacy-approval'
  /** Inside a flow whose journal predates flow-scoped effect keys. None of its recorded
   *  steps would match, so every effect it already performed would run a second time. */
  | 'legacy-effect-keys';

export interface UnresumableRun {
  sessionId: string;
  runId: string;
  reason: UnresumableReason;
  /** The flow it is parked in, when the reason is `legacy-effect-keys`. */
  activeFlow?: string;
  /** What the run is waiting on, when the reason is `legacy-approval`. */
  waitingFor?: string;
  /** Effects already journaled — how much would re-run if this were forced through. */
  recordedSteps: number;
  updatedAt: number;
}

/**
 * Find persisted runs that this version will refuse to resume, so they can be drained
 * before an upgrade rather than discovered by a user mid-conversation.
 *
 * Both refusals exist because the alternative is worse than an error: resuming a
 * pre-request-bound approval would let call order decide what got approved, and resuming
 * an in-flow run under the old effect-key scheme would re-execute effects it has already
 * performed — a real payment, a real dispatch.
 *
 * Run this against production BEFORE deploying. Each result needs a human decision:
 * finish the conversation on the old version, or resolve it out of band.
 *
 * ```ts
 * const stuck = await findUnresumableRuns(sessionStore);
 * for (const run of stuck) console.log(run.sessionId, run.reason, run.recordedSteps);
 * ```
 *
 * Only inspects sessions the store returns from `list()`; pass `sessionIds` to check a
 * known subset instead (large stores, or a paginated sweep you drive yourself).
 */
export async function findUnresumableRuns(
  sessionStore: SessionStore,
  options: { sessionIds?: string[] } = {},
): Promise<UnresumableRun[]> {
  const ids =
    options.sessionIds ?? (await sessionStore.list()).map((session) => session.id);
  const found: UnresumableRun[] = [];

  for (const sessionId of ids) {
    const session = await sessionStore.get(sessionId);
    if (!session) continue;
    const runs = readSessionDurableRuns(session);

    for (const [runId, persisted] of Object.entries(runs)) {
      const runState = persisted.runState;
      const steps = persisted.steps;
      const base = {
        sessionId,
        runId,
        recordedSteps: steps.length,
        updatedAt: runState.updatedAt,
      };

      if (runState.waitingFor && !runState.waitingFor.resumeKey) {
        found.push({
          ...base,
          reason: 'legacy-approval',
          waitingFor: runState.waitingFor.signalName,
        });
        continue;
      }

      if (
        runState.activeFlow &&
        steps.length > 0 &&
        runState.effectKeyVersion !== EFFECT_KEY_VERSION
      ) {
        found.push({
          ...base,
          reason: 'legacy-effect-keys',
          activeFlow: runState.activeFlow,
        });
      }
    }
  }

  return found;
}
