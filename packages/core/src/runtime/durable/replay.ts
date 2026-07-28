import type {
  InterruptDecisionRecord,
  RunState,
  SignalDelivery,
  StepRecord,
} from './types.js';
import { LogConflictError, type RunStore } from './RunStore.js';
import type { StandardSchemaV1 } from '../../types/standard-schema.js';

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
  options: {
    schema?: StandardSchemaV1;
    onDecision?: (decision: InterruptDecisionRecord) => void;
  } = {},
): Promise<boolean> {
  validateSignalDeliveryEnvelope(delivery);
  const steps = await runStore.getSteps(runState.runId);
  if (findStepBySignalId(steps, delivery.signalId)) {
    return false;
  }

  const waitingFor = runState.waitingFor;
  if (
    !waitingFor ||
    waitingFor.signalName !== delivery.name ||
    waitingFor.requestId !== delivery.requestId
  ) {
    throw new Error(
      `Signal ${delivery.name}/${delivery.requestId} does not match waitingFor ` +
        `${waitingFor ? `${waitingFor.signalName}/${waitingFor.requestId}` : 'none'}`,
    );
  }
  if (!isSignalActor(delivery.actor)) {
    throw new Error('Signal delivery requires a host-authenticated actor');
  }
  if (waitingFor.deadline !== null && Date.now() > waitingFor.deadline) {
    throw new Error(`Interrupt ${waitingFor.requestId} expired before delivery`);
  }

  let result: unknown;
  if (waitingFor.kind === 'approval') {
    if (
      (delivery.decision !== 'approve' && delivery.decision !== 'deny') ||
      delivery.payload !== undefined
    ) {
      throw new Error('Approval delivery requires a literal approve/deny decision and no payload');
    }
    result = {
      approved: delivery.decision === 'approve',
      by: delivery.actor.id,
      ...(delivery.reason !== undefined ? { reason: delivery.reason } : {}),
    };
  } else {
    if (delivery.decision !== undefined) {
      throw new Error('Custom signal delivery uses payload, not an approval decision');
    }
    if (!options.schema) {
      throw new Error(`Signal ${delivery.name} has no runtime validation schema`);
    }
    const validation = await options.schema['~standard'].validate(delivery.payload);
    if ('issues' in validation) {
      throw new Error(
        `Invalid signal payload: ${validation.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    result = validation.value;
  }

  // The key pauseEffect used when it suspended. Every request this version creates carries
  // it, and `resumePendingInterrupt` already dereferences it unconditionally. Deriving it
  // positionally as a fallback would reinstate call-order identity for exactly the runs
  // that cannot tolerate it — ones already paused on a durable store when the upgrade
  // landed. Refuse them by name instead of guessing.
  const key = waitingFor.resumeKey;
  if (!key) {
    throw new Error(
      `Interrupt ${waitingFor.requestId} has no resumeKey: it was created before ` +
        `request-bound approvals. Resolve this run out of band; it cannot be resumed safely.`,
    );
  }
  if (findStepByKey(steps, key)) {
    return false;
  }

  const now = Date.now();
  const decision: InterruptDecisionRecord = {
    requestId: waitingFor.requestId,
    signalId: delivery.signalId,
    actor: delivery.actor,
    ...(delivery.decision !== undefined ? { decision: delivery.decision } : {}),
    ...(delivery.reason !== undefined ? { reason: delivery.reason } : {}),
    decidedAt: now,
  };
  const record: StepRecord = {
    index: steps.length,
    key,
    kind: waitingFor.kind,
    name: delivery.name,
    signalId: delivery.signalId,
    status: 'finished',
    result,
    startedAt: now,
    finishedAt: now,
    epoch: runState.runEpoch ?? 0,
    interruptDecision: decision,
  };

  try {
    await runStore.appendStep(runState.runId, record);
  } catch (error) {
    if (!(error instanceof LogConflictError)) throw error;
    // Lost an append race. That is only benign if the winner decided THIS request — a
    // conflict from any other concurrent write is a real failure and must still surface.
    const latest = await runStore.getSteps(runState.runId);
    const decided = latest.some(
      (step) => step.interruptDecision?.requestId === waitingFor.requestId,
    );
    if (!decided) throw error;
    return false;
  }
  // A decision and the frozen operation it authorises are two separate durable writes.
  // Clearing the request here would orphan the operation if the process died in between:
  // `resumePendingInterrupt` is its only consumer and is reached via `waitingFor`. Keep
  // the request until the operation has actually run; that path clears it. Requests with
  // nothing left to execute (custom signals, approvals with no frozen operation) are done.
  if (!waitingFor.operation) {
    runState.waitingFor = undefined;
  }
  runState.status = 'running';
  runState.updatedAt = now;
  await runStore.putRunState(runState);
  options.onDecision?.(decision);
  return true;
}

function validateSignalDeliveryEnvelope(delivery: SignalDelivery): void {
  if (typeof delivery !== 'object' || delivery === null || Array.isArray(delivery)) {
    throw new Error('Signal delivery must be an object');
  }
  for (const field of ['signalId', 'requestId', 'name'] as const) {
    if (typeof delivery[field] !== 'string' || delivery[field].trim().length === 0) {
      throw new Error(`Signal delivery requires a non-empty ${field}`);
    }
  }
  const allowed = new Set([
    'signalId',
    'requestId',
    'name',
    'actor',
    'decision',
    'reason',
    'payload',
  ]);
  const extra = Object.keys(delivery).find((field) => !allowed.has(field));
  if (extra) {
    throw new Error(`Signal delivery contains unknown field "${extra}"`);
  }
  if (!isSignalActor(delivery.actor)) {
    throw new Error('Signal delivery requires a host-authenticated actor');
  }
  if (delivery.reason !== undefined && typeof delivery.reason !== 'string') {
    throw new Error('Signal delivery reason must be a string');
  }
}

function isSignalActor(value: unknown): value is SignalDelivery['actor'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actor = value as { id?: unknown; type?: unknown };
  return (
    Object.keys(actor).every((field) => field === 'id' || field === 'type') &&
    typeof actor.id === 'string' &&
    actor.id.length > 0 &&
    (actor.type === 'user' || actor.type === 'service' || actor.type === 'system')
  );
}

export async function loadRecordedSteps(
  runStore: RunStore,
  runId: string,
): Promise<StepRecord[]> {
  return runStore.getSteps(runId);
}
