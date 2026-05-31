import type { ModelMessage } from 'ai';
import type { ChannelDriver } from '../types/channel.js';
import type { Flow, FlowNode } from '../types/flow.js';
import type { RunContext, ActionContext } from '../types/run-context.js';
import type { RunState } from '../runtime/durable/types.js';
import { hasPendingUserInput } from '../runtime/channels/inputBuffer.js';
import { collectUntilComplete } from './collectUntilComplete.js';
import {
  isActionNode,
  isCollectNode,
  isDecideNode,
  isReplyNode,
} from './nodeKinds.js';
import { normalizeTransition, resolveNodeRef } from './normalizeTransition.js';
import type { NormalizedTransition } from './normalizeTransition.js';
import { reduceTransition } from './reduceTransition.js';
import { resolveReplyNode } from './nodeBuilders.js';
import { runNodeVerify, VerifyBlockedError } from './verify.js';
import { loadRecordedSteps } from '../runtime/durable/replay.js';

export type FlowResult =
  | { kind: 'ended'; reason: string }
  | { kind: 'handoff'; to: string; reason?: string }
  | { kind: 'awaitingUser' };

export class FlowOscillationError extends Error {
  constructor(from: string, to: string) {
    super(`Flow oscillation blocked: ${from} -> ${to}`);
    this.name = 'FlowOscillationError';
  }
}

function buildNodeRegistry(flow: Flow): Map<string, FlowNode> {
  const registry = new Map<string, FlowNode>();
  for (const node of flow.nodes) {
    registry.set(node.id, node);
  }
  return registry;
}

function resolveStartNode(flow: Flow): FlowNode {
  return resolveNodeRef(flow.start);
}

function bumpOscillation(edgeCounts: Map<string, number>, from: string, to: string): number {
  const key = `${from}->${to}`;
  const next = (edgeCounts.get(key) ?? 0) + 1;
  edgeCounts.set(key, next);
  return next;
}

function toActionContext(ctx: RunContext): ActionContext {
  return {
    tool: ctx.tool.bind(ctx),
    approve: ctx.approve.bind(ctx),
    signal: ctx.signal.bind(ctx),
    now: ctx.now.bind(ctx),
    uuid: ctx.uuid.bind(ctx),
    emit: ctx.emit.bind(ctx),
  };
}

function appendUserMessage(run: RunState, input: string): void {
  const message: ModelMessage = { role: 'user', content: input };
  run.messages = [...run.messages, message];
}

function appendAssistantMessage(run: RunState, text: string): void {
  if (!text.trim()) {
    return;
  }
  const message: ModelMessage = { role: 'assistant', content: text };
  run.messages = [...run.messages, message];
}

async function dispatchNode(
  node: FlowNode,
  run: RunState,
  driver: ChannelDriver,
  ctx: RunContext,
): Promise<NormalizedTransition> {
  if (isActionNode(node)) {
    return normalizeTransition(await node.run(run.state, toActionContext(ctx)));
  }

  if (isCollectNode(node)) {
    return collectUntilComplete(node, run, driver, ctx);
  }

  if (isDecideNode(node)) {
    if (!driver.runStructured) {
      throw new Error('ChannelDriver.runStructured is required for decide nodes');
    }
    const structured = await driver.runStructured(node, ctx);
    return normalizeTransition(await node.decide(structured, run.state));
  }

  if (isReplyNode(node)) {
    const turn = await driver.runAgentTurn(resolveReplyNode(node, run.state), ctx);
    appendAssistantMessage(run, turn.text);

    if (turn.interrupted) {
      const signal = await driver.awaitUser(ctx);
      appendUserMessage(run, signal.input);
      return dispatchNode(node, run, driver, ctx);
    }

    if (turn.control?.type === 'handoff') {
      return { kind: 'handoff', to: turn.control.target, reason: turn.control.reason };
    }
    if (turn.control?.type === 'end') {
      return { kind: 'end', reason: turn.control.reason };
    }

    if (node.next) {
      return normalizeTransition(await node.next(turn, run.state));
    }
    return { kind: 'stay' };
  }

  throw new Error(`Unknown node kind: ${(node as FlowNode).kind}`);
}

export async function runFlow(
  flow: Flow,
  run: RunState,
  driver: ChannelDriver,
  ctx: RunContext,
): Promise<FlowResult> {
  const registry = buildNodeRegistry(flow);
  const startNode = resolveStartNode(flow);
  const initialNodeId = run.activeNode ?? startNode.id;
  let node = registry.get(initialNodeId);
  if (!node) {
    throw new Error(`Unknown active node "${initialNodeId}" in flow "${flow.name}"`);
  }

  if (!run.activeNode) {
    run.activeNode = node.id;
    run.activeFlow = flow.name;
    ctx.emit({ type: 'flow-enter', flow: flow.name });
    ctx.emit({ type: 'node-enter', nodeName: node.id });
  }

  const edgeCounts = new Map<string, number>();
  const maxOscillations = flow.maxOscillations ?? 2;

  for (;;) {
    const transition = await dispatchNode(node, run, driver, ctx);

    if (transition.kind === 'end') {
      ctx.emit({ type: 'flow-end', flow: flow.name, reason: transition.reason });
      return { kind: 'ended', reason: transition.reason };
    }

    if (transition.kind === 'handoff') {
      ctx.emit({ type: 'handoff', targetAgent: transition.to, reason: transition.reason });
      return { kind: 'handoff', to: transition.to, reason: transition.reason };
    }

    if (transition.kind === 'escalate') {
      await ctx.signal('__escalate', { meta: { reason: transition.reason } });
      return { kind: 'handoff', to: 'human', reason: transition.reason };
    }

    if (transition.kind === 'stay') {
      if (!hasPendingUserInput(ctx.session)) {
        await ctx.runStore.putRunState(run);
        return { kind: 'awaitingUser' };
      }
      const signal = await driver.awaitUser(ctx);
      appendUserMessage(run, signal.input);
      await ctx.runStore.putRunState(run);
      continue;
    }

    const target = transition.node;
    if (!registry.has(target.id)) {
      registry.set(target.id, target);
    }

    const steps = await loadRecordedSteps(ctx.runStore, run.runId);
    try {
      await runNodeVerify(node, {
        state: run.state,
        steps,
        data: transition.data,
      });
    } catch (error) {
      if (error instanceof VerifyBlockedError) {
        ctx.emit({ type: 'error', error: error.message });
        return { kind: 'awaitingUser' };
      }
      throw error;
    }

    const oscillation = bumpOscillation(edgeCounts, node.id, target.id);
    if (oscillation > maxOscillations) {
      ctx.emit({ type: 'error', error: `Flow oscillation blocked: ${node.id} -> ${target.id}` });
      throw new FlowOscillationError(node.id, target.id);
    }

    await reduceTransition({
      fromNodeId: node.id,
      toNode: target,
      run,
      flow,
      model: ctx.model,
      data: transition.data,
      emit: ctx.emit,
      abortSignal: ctx.abortSignal,
    });
    await ctx.runStore.putRunState(run);
    node = target;
  }
}
