import type {
  ActionNode,
  CollectNode,
  DecideNode,
  FlowNode,
  ReplyNode,
} from '../types/flow.js';

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
