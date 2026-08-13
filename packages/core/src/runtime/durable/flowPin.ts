import type { Flow } from '../../types/flow.js';
import { digestForLiveFlow } from '../../flows/definition/digest.js';
import { EFFECT_KEY_VERSION } from './effectKeyVersion.js';
import type { RunFlowRef, RunState } from './types.js';

export type FlowDriftRecovery = 'restart' | 'abandon';

export class FlowDriftError extends Error {
  readonly name = 'FlowDriftError';
  readonly runId: string;
  readonly flowName: string;
  readonly parkedNode: string;
  readonly expectedDigest: string;
  readonly actualDigest: string;
  readonly recovery: readonly FlowDriftRecovery[];

  constructor(fields: {
    runId: string;
    flowName: string;
    parkedNode: string;
    expectedDigest: string;
    actualDigest: string;
  }) {
    super(
      `Flow "${fields.flowName}" changed while run ${fields.runId} was parked at node "${fields.parkedNode}". ` +
        `Expected digest ${fields.expectedDigest} but the current definition is ${fields.actualDigest}. ` +
        `This run cannot resume against the new definition.`,
    );
    this.runId = fields.runId;
    this.flowName = fields.flowName;
    this.parkedNode = fields.parkedNode;
    this.expectedDigest = fields.expectedDigest;
    this.actualDigest = fields.actualDigest;
    this.recovery = ['restart', 'abandon'];
  }
}

export async function stampActiveFlow(run: RunState, flow: Flow): Promise<void> {
  run.activeFlow = flow.name;
  run.flowDigest = await digestForLiveFlow(flow);
  run.flowRef = flow.versionId !== undefined ? { name: flow.name, versionId: flow.versionId } : undefined;
}

export function clearFlowPin(run: RunState): void {
  run.flowDigest = undefined;
  run.flowRef = undefined;
}

export function clearActiveFlow(run: RunState): void {
  run.activeFlow = undefined;
  run.activeNode = undefined;
  run.flowFrame = undefined;
  run.flowStack = undefined;
  clearFlowPin(run);
  if (run.effectKeyVersion !== EFFECT_KEY_VERSION) {
    run.effectKeyVersion = EFFECT_KEY_VERSION;
  }
}

export function captureFlowPin(run: RunState): { flowDigest?: string; flowRef?: RunFlowRef } {
  return {
    ...(run.flowDigest !== undefined ? { flowDigest: run.flowDigest } : {}),
    ...(run.flowRef !== undefined ? { flowRef: { ...run.flowRef } } : {}),
  };
}

export function restoreFlowPin(
  run: RunState,
  pin: { flowDigest?: string; flowRef?: RunFlowRef },
): void {
  run.flowDigest = pin.flowDigest;
  run.flowRef = pin.flowRef !== undefined ? { ...pin.flowRef } : undefined;
}

/**
 * Parked resume is fail-closed against a new definition. A missing stamp is
 * a legacy run — classify, don't break. The stamp is not caller-supplied
 * authority: this compares what we wrote on entry to a digest we recompute
 * from the live flow.
 */
export async function assertParkedFlowDigest(run: RunState, flow: Flow): Promise<void> {
  if (!run.activeNode || run.flowDigest === undefined) return;
  const actualDigest = await digestForLiveFlow(flow);
  if (actualDigest === run.flowDigest) return;
  throw new FlowDriftError({
    runId: run.runId,
    flowName: flow.name,
    parkedNode: run.activeNode,
    expectedDigest: run.flowDigest,
    actualDigest,
  });
}
