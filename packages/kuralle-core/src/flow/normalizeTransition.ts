import type { FlowNode, Transition } from '../types/flow.js';

export type NormalizedTransition =
  | { kind: 'goto'; node: FlowNode; data?: Record<string, unknown> }
  | { kind: 'handoff'; to: string; reason?: string }
  | { kind: 'escalate'; reason: string }
  | { kind: 'end'; reason: string }
  | { kind: 'stay' };

const NODE_KINDS = new Set(['reply', 'collect', 'action', 'decide']);

export function resolveNodeRef(ref: FlowNode | (() => FlowNode)): FlowNode {
  return typeof ref === 'function' ? ref() : ref;
}

function isFlowNode(value: unknown): value is FlowNode {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const kind = (value as FlowNode).kind;
  return typeof kind === 'string' && NODE_KINDS.has(kind) && typeof (value as FlowNode).id === 'string';
}

export function normalizeTransition(transition: Transition): NormalizedTransition {
  if (transition === 'stay') {
    return { kind: 'stay' };
  }

  if (typeof transition === 'function') {
    return { kind: 'goto', node: transition() };
  }

  if (isFlowNode(transition)) {
    return { kind: 'goto', node: transition };
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
        node: resolveNodeRef(transition.goto),
        data: transition.data,
      };
    }
  }

  throw new Error(`Invalid transition: ${String(transition)}`);
}
