import type { TurnControl } from '../types/channel.js';
import type { FlowState, ReplyNode } from '../types/flow.js';
import type { TurnResult } from '../types/channel.js';
import { normalizeTransition, type NormalizedTransition } from './normalizeTransition.js';

export interface ControlSignal {
  node: ReplyNode;
  turn: TurnResult;
  state: FlowState;
  interrupted: boolean;
}

export type ControlDecision =
  | { kind: 'transition'; transition: NormalizedTransition }
  | { kind: 'redispatch' }
  | { kind: 'stay' };

function controlToTransition(control: TurnControl): NormalizedTransition {
  switch (control.type) {
    case 'handoff':
      return { kind: 'handoff', to: control.target, reason: control.reason };
    case 'end':
      return { kind: 'end', reason: control.reason };
    case 'escalate':
      return { kind: 'escalate', reason: control.reason };
    case 'recover':
      return { kind: 'end', reason: control.reason ?? 'error_degraded' };
    case 'enterFlow':
      // enter_flow is a host-turn-only control (routing.mode:'tools'); it is
      // never injected into in-flow reply nodes, so it cannot reach the in-flow
      // evaluator. Treated as an invariant violation if it ever does.
      throw new Error(
        `enter_flow control reached the in-flow evaluator (flow "${control.flowName}") — it is host-only`,
      );
  }
}

export async function evaluateReplyControl(signal: ControlSignal): Promise<ControlDecision> {
  const { node, turn, state, interrupted } = signal;

  if (interrupted) {
    return { kind: 'redispatch' };
  }

  if (turn.control) {
    return { kind: 'transition', transition: controlToTransition(turn.control) };
  }

  if (node.next) {
    return { kind: 'transition', transition: normalizeTransition(await node.next(turn, state)) };
  }

  return { kind: 'stay' };
}
