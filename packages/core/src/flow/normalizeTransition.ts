import type { Flow, FlowNode, Transition } from '../types/flow.js';
import type { FlowPark } from './collectDigression.js';
import { isFlowNode } from './nodeKinds.js';

type FlowParkRef = Pick<FlowPark, 'flow' | 'node'>;

export type NormalizedTransition =
  | { kind: 'goto'; to: FlowNode | string; data?: Record<string, unknown> }
  | { kind: 'handoff'; to: string; reason?: string }
  | { kind: 'escalate'; reason: string }
  | { kind: 'end'; reason: string }
  | { kind: 'stay' }
  | { kind: 'switchFlow'; flow: Flow; park: FlowParkRef };

export function resolveNodeRef(ref: FlowNode | (() => FlowNode)): FlowNode {
  return typeof ref === 'function' ? ref() : ref;
}

export function normalizeTransition(transition: Transition): NormalizedTransition {
  if (transition === 'stay') {
    return { kind: 'stay' };
  }

  if (isFlowNode(transition)) {
    return { kind: 'goto', to: transition };
  }

  if (typeof transition === 'object' && transition !== null) {
    if ('end' in transition) {
      return { kind: 'end', reason: transition.end };
    }
    if ('handoff' in transition) {
      return { kind: 'handoff', to: transition.handoff, reason: transition.reason };
    }
    if ('escalate' in transition) {
      return { kind: 'escalate', reason: transition.escalate };
    }
    if ('goto' in transition) {
      return {
        kind: 'goto',
        to: transition.goto,
        data: transition.data,
      };
    }
  }

  throw new Error(`Invalid transition: ${String(transition)}`);
}
