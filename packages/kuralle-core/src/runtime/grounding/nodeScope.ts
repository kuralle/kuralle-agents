import type { ModelMessage } from 'ai';
import type { FlowState, ReplyNode } from '../../types/flow.js';
import type { GatherScope } from '../../types/run-context.js';

export function resolveNodeGatherScope(
  node: ReplyNode,
  state: FlowState,
  history: ModelMessage[],
): GatherScope | undefined {
  const g = node.grounding;
  if (!g) {
    return undefined;
  }
  return {
    query: typeof g.query === 'function' ? g.query(state, history) : g.query,
    knowledge: g.knowledge,
    memory: g.memory,
  };
}
