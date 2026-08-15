import type { SessionStore } from '../../session/SessionStore.js';
import { isResumableEffectKeyVersion } from './effectKeyVersion.js';
import { SessionRunStore } from './SessionRunStore.js';

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
  const enumerator = new SessionRunStore(sessionStore, options.sessionIds?.[0] ?? '');
  const allow = options.sessionIds ? new Set(options.sessionIds) : undefined;
  const found: UnresumableRun[] = [];

  for await (const ref of enumerator.listRuns({})) {
    const sessionId = ref.sessionId;
    if (!sessionId) continue;
    if (allow && !allow.has(sessionId)) continue;

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const runState = await runStore.getRunState(ref.runId);
    if (!runState) continue;
    const steps = await runStore.getSteps(ref.runId);
    const base = {
      sessionId,
      runId: ref.runId,
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
      !isResumableEffectKeyVersion(runState.effectKeyVersion)
    ) {
      found.push({
        ...base,
        reason: 'legacy-effect-keys',
        activeFlow: runState.activeFlow,
      });
    }
  }

  return found;
}
