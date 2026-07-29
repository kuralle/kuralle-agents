import type { Flow, FlowState } from '../types/flow.js';
import type { RunState } from '../runtime/durable/types.js';

export function currentFlowState(run: RunState): FlowState {
  return run.flowFrame?.state ?? run.state;
}

export function enterFlowState(
  run: RunState,
  flow: Flow,
  source: FlowState = run.state,
): FlowState {
  const state = flow.state?.input?.(source) ?? {};
  run.flowFrame = { flow: flow.name, state };
  return state;
}

export function exportFlowState(flow: Flow, state: FlowState): Record<string, unknown> {
  return flow.state?.output?.(state) ?? {};
}
