import type { LanguageModel } from 'ai';
import type { Flow, FlowNode } from '../types/flow.js';
import type { RunState } from '../runtime/durable/types.js';
import type { HarnessStreamPart } from '../types/stream.js';
import { applyContextStrategy, resolveContextStrategy } from './contextStrategy.js';
import { emitInteractiveOnNodeEnter } from './emitInteractive.js';

export interface ReduceTransitionInput {
  fromNodeId: string;
  toNode: FlowNode;
  run: RunState;
  flow: Flow;
  model: LanguageModel;
  data?: Record<string, unknown>;
  emit: (part: HarnessStreamPart) => void;
  abortSignal?: AbortSignal;
}

function resolveNodeContext(toNode: FlowNode, flow: Flow): ReturnType<typeof resolveContextStrategy> {
  if (toNode.kind === 'reply' && toNode.context) {
    return toNode.context;
  }
  return resolveContextStrategy(undefined, flow);
}

export async function reduceTransition(input: ReduceTransitionInput): Promise<void> {
  const { fromNodeId, toNode, run, flow, model, data, emit, abortSignal } = input;

  emit({ type: 'node-exit', nodeName: fromNodeId });
  emit({ type: 'flow-transition', from: fromNodeId, to: toNode.id });
  emit({ type: 'node-enter', nodeName: toNode.id });
  emitInteractiveOnNodeEnter(toNode, run.state, emit);

  await applyContextStrategy({
    strategy: resolveNodeContext(toNode, flow),
    run,
    flow,
    model,
    abortSignal,
  });

  if (data) {
    Object.assign(run.state, data);
  }

  run.activeNode = toNode.id;
  run.activeFlow = flow.name;
  run.updatedAt = Date.now();
}
