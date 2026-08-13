import type {
  ActionNode,
  CollectNode,
  DecideNode,
  FlowNode,
  ReplyNode,
} from '../types/flow.js';

const NODE_KINDS = new Set(['reply', 'collect', 'action', 'decide']);

export function isFlowNode(value: unknown): value is FlowNode {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const kind = (value as FlowNode).kind;
  return typeof kind === 'string' && NODE_KINDS.has(kind) && typeof (value as FlowNode).id === 'string';
}

export function isReplyNode(node: FlowNode): node is ReplyNode {
  return node.kind === 'reply';
}

export function isCollectNode(node: FlowNode): node is CollectNode {
  return node.kind === 'collect';
}

export function isActionNode(node: FlowNode): node is ActionNode {
  return node.kind === 'action';
}

export function isDecideNode(node: FlowNode): node is DecideNode {
  return node.kind === 'decide';
}
