import type { Instructions } from '../types/agentConfig.js';
import type { CollectNode, DecideNode, FlowNode, FlowState } from '../types/flow.js';
import type { HarnessStreamPart } from '../types/stream.js';
import { resolveInstructions } from './nodeBuilders.js';
import { isCollectNode, isDecideNode } from './nodeKinds.js';

function resolveCollectPrompt(
  instructions: (missing: string[], state: FlowState) => Instructions,
  state: FlowState,
): string {
  const inst = instructions([], state);
  if (typeof inst === 'string') {
    return inst;
  }
  if (typeof inst === 'function') {
    const result = inst({ state });
    return typeof result === 'string' ? result : '';
  }
  return '';
}

function interactivePrompt(node: CollectNode | DecideNode, state: FlowState): string {
  if (node.kind === 'decide') {
    try {
      return resolveInstructions(node.instructions, state);
    } catch {
      return '';
    }
  }
  if (!node.instructions) {
    return '';
  }
  try {
    return resolveCollectPrompt(node.instructions, state);
  } catch {
    return '';
  }
}

export function emitInteractiveOnNodeEnter(
  node: FlowNode,
  state: FlowState,
  emit: (part: HarnessStreamPart) => void,
): void {
  if (!(isCollectNode(node) || isDecideNode(node)) || !node.choices?.length) {
    return;
  }
  emit({
    type: 'interactive',
    nodeId: node.id,
    options: node.choices,
    prompt: interactivePrompt(node, state),
  });
}
