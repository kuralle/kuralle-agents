import type { ChannelDriver } from '../types/channel.js';
import type { Flow, FlowNode } from '../types/flow.js';
import type { RunContext } from '../types/run-context.js';
import type { RunState } from '../runtime/durable/types.js';
import { SuspendError } from '../runtime/durable/RunStore.js';
import type { ModelMessage } from 'ai';

type DegradedFlowResult =
  | { kind: 'ended'; reason: string }
  | { kind: 'handoff'; to: string; reason?: string };

export const SAFE_DEGRADED_MESSAGE =
  "I'm sorry — something went wrong on my side. Let me try to help you another way.";

export function findEscalateNode(registry: Map<string, FlowNode>): FlowNode | undefined {
  return registry.get('escalate');
}

export function appendSafeAssistantMessage(run: RunState, ctx: RunContext, text = SAFE_DEGRADED_MESSAGE): void {
  const message: ModelMessage = { role: 'assistant', content: text };
  run.messages = [...run.messages, message];
  ctx.emit({ type: 'text-delta', text });
}

export async function degradeFlowError(
  flow: Flow,
  registry: Map<string, FlowNode>,
  run: RunState,
  driver: ChannelDriver,
  ctx: RunContext,
  dispatchNode: (
    node: FlowNode,
    run: RunState,
    driver: ChannelDriver,
    ctx: RunContext,
  ) => Promise<import('./normalizeTransition.js').NormalizedTransition>,
): Promise<DegradedFlowResult> {
  appendSafeAssistantMessage(run, ctx);

  const escalateNode = findEscalateNode(registry);
  if (escalateNode) {
    try {
      const transition = await dispatchNode(escalateNode, run, driver, ctx);
      if (transition.kind === 'escalate') {
        await ctx.signal('__escalate', { meta: { reason: transition.reason } });
        return { kind: 'handoff', to: 'human', reason: transition.reason };
      }
    } catch (error) {
      if (error instanceof SuspendError) {
        throw error;
      }
      // Fall through to graceful end if the escalate node also fails.
    }
  }

  ctx.emit({ type: 'flow-end', flow: flow.name, reason: 'error_degraded' });
  return { kind: 'ended', reason: 'error_degraded' };
}
