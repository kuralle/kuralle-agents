import type { RunState, SignalDelivery, StepRecord } from './types.js';
import type { RunStore } from './RunStore.js';
import { pauseEffectKey, logicalRunId } from './idempotency.js';

export function findStepByKey(steps: StepRecord[], key: string): StepRecord | undefined {
  return steps.find((step) => step.key === key);
}

function findStepBySignalId(steps: StepRecord[], signalId: string): StepRecord | undefined {
  return steps.find((step) => step.signalId === signalId);
}

export async function recordSignalDelivery(
  runStore: RunStore,
  runState: RunState,
  delivery: SignalDelivery,
): Promise<boolean> {
  const steps = await runStore.getSteps(runState.runId);
  if (findStepBySignalId(steps, delivery.signalId)) {
    return false;
  }

  const waitingFor = runState.waitingFor;
  if (!waitingFor || waitingFor.signalName !== delivery.name) {
    throw new Error(
      `Signal ${delivery.name} does not match waitingFor ${waitingFor?.signalName ?? 'none'}`,
    );
  }

  // Must match the key pauseEffect used when it suspended: the keystone scopes the
  // effect-key namespace by logical run (runId#epoch), so the resume-side delivery
  // key has to use logicalRunId too, else the pause never finds its own decision.
  const key = pauseEffectKey(logicalRunId(runState.runId, runState.runEpoch), waitingFor.callsite, delivery.name);
  if (findStepByKey(steps, key)) {
    return false;
  }

  const now = Date.now();
  const record: StepRecord = {
    index: steps.length,
    key,
    kind: waitingFor.approval ? 'approval' : 'signal',
    name: delivery.name,
    signalId: delivery.signalId,
    status: 'finished',
    result: delivery.payload,
    startedAt: now,
    finishedAt: now,
    epoch: runState.runEpoch ?? 0,
  };

  await runStore.appendStep(runState.runId, record);
  runState.waitingFor = undefined;
  runState.status = 'running';
  runState.updatedAt = now;
  await runStore.putRunState(runState);
  return true;
}

export async function loadRecordedSteps(
  runStore: RunStore,
  runId: string,
): Promise<StepRecord[]> {
  return runStore.getSteps(runId);
}
