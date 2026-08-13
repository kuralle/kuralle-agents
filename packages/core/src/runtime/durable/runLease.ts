import type { RunState } from './types.js';
import type { RunStore } from './RunStore.js';

export const DEFAULT_RUN_LEASE_TTL_MS = 30_000;

export function isRunLeaseStale(leaseExpiresAt: number | undefined, now: number): boolean {
  return leaseExpiresAt != null && leaseExpiresAt < now;
}

export function takeRunLease(state: RunState, holder: string, ttlMs: number, now: number): void {
  state.leaseHolder = holder;
  state.leaseExpiresAt = now + ttlMs;
}

export function clearRunLease(state: RunState): void {
  delete state.leaseHolder;
  delete state.leaseExpiresAt;
}

export function wrapWithRunLease(
  inner: RunStore,
  opts: { holder: string; ttlMs: number; now?: () => number },
): RunStore {
  const now = opts.now ?? Date.now;

  const wrapped: RunStore = {
    appendStep: (runId, record) => inner.appendStep(runId, record),
    finalizeStep: (runId, key, patch) => inner.finalizeStep(runId, key, patch),
    getSteps: (runId) => inner.getSteps(runId),
    getRunState: (runId) => inner.getRunState(runId),
    putRunState: async (state) => {
      if (state.leaseHolder !== undefined || state.leaseExpiresAt !== undefined) {
        takeRunLease(state, opts.holder, opts.ttlMs, now());
      }
      await inner.putRunState(state);
    },
    listRuns: (filter) => inner.listRuns(filter),
    deleteRun: (runId, options) => inner.deleteRun(runId, options),
  };

  if (inner.initRun) {
    wrapped.initRun = (state) => inner.initRun!(state);
  }
  if (inner.pruneStepsBeforeEpoch) {
    wrapped.pruneStepsBeforeEpoch = (runId, keepEpoch) =>
      inner.pruneStepsBeforeEpoch!(runId, keepEpoch);
  }
  if (inner.reserveSteps) {
    wrapped.reserveSteps = (runId, count) => inner.reserveSteps!(runId, count);
  }

  return wrapped;
}
