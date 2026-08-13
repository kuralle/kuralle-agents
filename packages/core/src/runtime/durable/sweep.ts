import type { TurnHandle } from '../../types/stream.js';
import type { RunOptions } from '../Runtime.js';
import type { RunStore } from './RunStore.js';
import type { RunRef } from './types.js';
import { deadlineExpiryDelivery } from './deadlineExpiry.js';
import { isRunLeaseStale } from './runLease.js';

export interface SweepRuntime {
  run(opts: RunOptions): TurnHandle;
  getRunStore(): RunStore;
}

export interface RecoverOrphanedRunsOptions {
  olderThan?: Date | number;
}

export interface RecoverOrphanedRunsReport {
  recovered: RunRef[];
  skippedLive: number;
}

export interface SweepDeadlinesOptions {
  now?: Date | number;
}

function toEpoch(value: Date | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return value instanceof Date ? value.getTime() : value;
}

async function drainTurn(handle: TurnHandle): Promise<void> {
  for await (const _part of handle.events) {
    void _part;
  }
  await handle;
}

async function collectRefs(
  store: RunStore,
  filter: Parameters<RunStore['listRuns']>[0],
): Promise<RunRef[]> {
  const refs: RunRef[] = [];
  for await (const ref of store.listRuns(filter)) {
    refs.push(ref);
  }
  return refs;
}

/**
 * Re-enter `running` runs whose execution lease is stale (crashed replica).
 * Live leases are left alone. Re-entry is `Runtime.run({ sessionId, runId })`
 * — the same fail-closed resume path as any other addressed run.
 */
export async function recoverOrphanedRuns(
  runtime: SweepRuntime,
  options: RecoverOrphanedRunsOptions = {},
): Promise<RecoverOrphanedRunsReport> {
  const cutoff = toEpoch(options.olderThan, Date.now());
  const store = runtime.getRunStore();
  const running = await collectRefs(store, { status: 'running' });
  const recovered: RunRef[] = [];
  let skippedLive = 0;
  const failures: unknown[] = [];

  for (const ref of running) {
    if (!isRunLeaseStale(ref.leaseExpiresAt, cutoff)) {
      skippedLive += 1;
      continue;
    }
    if (!ref.sessionId) {
      failures.push(new Error(`Orphaned run ${ref.runId} has no sessionId`));
      continue;
    }
    try {
      await drainTurn(runtime.run({ sessionId: ref.sessionId, runId: ref.runId }));
      recovered.push(ref);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `recoverOrphanedRuns failed for ${failures.length} run(s)`);
  }
  return { recovered, skippedLive };
}

/**
 * Deliver the timeout outcome to paused runs whose `waitingFor.deadline` is in
 * the past. InterruptRequest has no configured outcome field; the default is a
 * structured deny (`reason: 'deadline-expired'`) through signalDelivery.
 */
export async function sweepDeadlines(
  runtime: SweepRuntime,
  options: SweepDeadlinesOptions = {},
): Promise<RunRef[]> {
  const now = toEpoch(options.now, Date.now());
  const store = runtime.getRunStore();
  const expired = await collectRefs(store, {
    status: 'paused',
    deadlineBefore: new Date(now),
  });
  const delivered: RunRef[] = [];
  const failures: unknown[] = [];

  for (const ref of expired) {
    const waitingFor = ref.waitingFor;
    if (!waitingFor || !ref.sessionId) {
      failures.push(new Error(`Paused run ${ref.runId} is missing sessionId or waitingFor`));
      continue;
    }
    try {
      await drainTurn(
        runtime.run({
          sessionId: ref.sessionId,
          runId: ref.runId,
          signalDelivery: deadlineExpiryDelivery(waitingFor),
        }),
      );
      delivered.push(ref);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `sweepDeadlines failed for ${failures.length} run(s)`);
  }
  return delivered;
}
