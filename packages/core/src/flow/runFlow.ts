import type { ModelMessage } from 'ai';
import type { AgentConfig } from '../types/agentConfig.js';
import type { ChannelDriver } from '../types/channel.js';
import type { DecideNode, Flow, FlowNode } from '../types/flow.js';
import { getFlowPark } from './collectDigression.js';
import { parseConfirmation } from './confirmParse.js';
import type { RunContext, ActionContext } from '../types/run-context.js';
import type { RunState } from '../runtime/durable/types.js';
import { hasPendingUserInput } from '../runtime/channels/inputBuffer.js';
import { userInputToText, type UserInputContent } from '../runtime/userInput.js';
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
import { evaluateReplyControl } from './controlEvaluator.js';
import { runNodeVerify, VerifyBlockedError } from './verify.js';
import { loadRecordedSteps } from '../runtime/durable/replay.js';
import { SuspendError } from '../runtime/durable/RunStore.js';
import { ToolApprovalDeniedError } from '../tools/effect/errors.js';
import { emitInteractiveOnNodeEnter } from './emitInteractive.js';
import { appendConversationAudit } from '../audit/record.js';
import {
  appendSafeAssistantMessage,
  degradeFlowError,
  findEscalateNode,
} from './degrade.js';

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

function appendUserMessage(run: RunState, input: UserInputContent): void {
  const message: ModelMessage = { role: 'user', content: input };
  run.messages = [...run.messages, message];
}

function latestUserText(run: RunState): string {
  for (let i = run.messages.length - 1; i >= 0; i -= 1) {
    const message = run.messages[i];
    if (message?.role === 'user') {
      const text = userInputToText(message.content);
      if (text) return text;
    }
  }
  return '';
}

async function dispatchConfirmGate(
  node: DecideNode,
  run: RunState,
  driver: ChannelDriver,
  ctx: RunContext,
): Promise<NormalizedTransition> {
  const gate = node.confirmGate!;
  if (!hasPendingUserInput(ctx.session) && ctx.turnInputConsumed) {
    return { kind: 'stay' };
  }

  let input = '';
  if (hasPendingUserInput(ctx.session)) {
    const signal = await driver.awaitUser(ctx);
    input = userInputToText(signal.input);
    appendUserMessage(run, signal.input);
  } else {
    input = latestUserText(run);
  }
  ctx.turnInputConsumed = true;

  const verdict = parseConfirmation(input);
  const branch =
    verdict === 'affirm'
      ? gate.onConfirm
      : verdict === 'decline'
        ? gate.onDecline
        : (gate.onAmbiguous ?? 'stay');

  return normalizeTransition(branch);
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
  agent: AgentConfig | undefined,
  flow: Flow,
): Promise<NormalizedTransition> {
  if (isActionNode(node)) {
    return normalizeTransition(await node.run(run.state, toActionContext(ctx)));
  }

  if (isCollectNode(node)) {
    return collectUntilComplete(node, run, driver, ctx, {
      agent,
      activeFlowName: flow.name,
    });
  }

  if (isDecideNode(node)) {
    if (node.confirmGate) {
      return dispatchConfirmGate(node, run, driver, ctx);
    }
    if (!driver.runStructured) {
      throw new Error('ChannelDriver.runStructured is required for decide nodes');
    }
    if (!node.schema || !node.decide) {
      throw new Error(`decide node "${node.id}" requires schema and decide`);
    }
    // An interactive choice node (withChoices) reached when the turn's input was
    // already consumed by a prior node: its choices were presented on node-enter,
    // so wait for the user to actually pick rather than auto-deciding on stale
    // context. Returning `stay` lets the loop park as `awaitingUser`. (A plain
    // decide with no choices is a pure branch and still runs; and an interactive
    // decide that IS the turn's first input-node still decides on that input.)
    if (node.choices?.length && !hasPendingUserInput(ctx.session) && ctx.turnInputConsumed) {
      return { kind: 'stay' };
    }
    // On resume, the new turn's input is buffered as pending and is not yet in
    // the message history the decision reads. Consume it first (mirrors the
    // collect path) so the decision sees the user's actual reply instead of
    // stale context — without this, a multi-turn flow stalls at the first
    // interactive decide because the reply never reaches `decide()`.
    if (hasPendingUserInput(ctx.session)) {
      const signal = await driver.awaitUser(ctx);
      appendUserMessage(run, signal.input);
    }
    // This decide consumes the turn's input for its decision.
    ctx.turnInputConsumed = true;
    const structured = await driver.runStructured(node, ctx);
    return normalizeTransition(await node.decide(structured, run.state));
  }

  if (isReplyNode(node)) {
    const turn = await driver.runAgentTurn(resolveReplyNode(node, run.state), ctx);

    if (ctx.outOfBandControl) {
      const decision = await evaluateReplyControl({
        node,
        turn,
        state: run.state,
        interrupted: !!turn.interrupted,
      });
      if (decision.kind === 'redispatch') {
        const signal = await driver.awaitUser(ctx);
        appendUserMessage(run, signal.input);
        return dispatchNode(node, run, driver, ctx, agent, flow);
      }
      appendAssistantMessage(run, turn.text);
      if (decision.kind === 'transition') {
        return decision.transition;
      }
      return { kind: 'stay' };
    }

    appendAssistantMessage(run, turn.text);

    if (turn.interrupted) {
      const signal = await driver.awaitUser(ctx);
      appendUserMessage(run, signal.input);
      return dispatchNode(node, run, driver, ctx, agent, flow);
    }

    if (turn.control?.type === 'handoff') {
      return { kind: 'handoff', to: turn.control.target, reason: turn.control.reason };
    }
    if (turn.control?.type === 'end') {
      return { kind: 'end', reason: turn.control.reason };
    }
    if (turn.control?.type === 'escalate') {
      return { kind: 'escalate', reason: turn.control.reason };
    }
    if (turn.control?.type === 'recover') {
      return { kind: 'end', reason: turn.control.reason ?? 'error_degraded' };
    }

    if (
      node.confidenceGate &&
      turn.confidence != null &&
      turn.confidence < node.confidenceGate.min
    ) {
      appendConversationAudit(
        ctx.session,
        {
          sessionId: ctx.session.id,
          conversationId: ctx.session.conversationId,
          userId: ctx.session.userId,
          agentId: ctx.runState.activeAgentId,
        },
        {
          type: 'escalation',
          reason: 'low-confidence',
          confidence: turn.confidence,
        },
      );
      return normalizeTransition(node.confidenceGate.onLow);
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
  agent?: AgentConfig,
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
    emitInteractiveOnNodeEnter(node, run.state, ctx.emit);
  }

  const edgeCounts = new Map<string, number>();
  const maxOscillations = flow.maxOscillations ?? 2;

  for (;;) {
    let transition: NormalizedTransition;
    try {
      transition = await dispatchNode(node, run, driver, ctx, agent, flow);
    } catch (error) {
      if (error instanceof SuspendError || error instanceof ToolApprovalDeniedError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      ctx.emit({ type: 'error', error: message });
      return degradeFlowError(flow, registry, run, driver, ctx, (n, r, d, c) =>
        dispatchNode(n, r, d, c, agent, flow),
      );
    }

    if (transition.kind === 'switchFlow') {
      run.activeFlow = transition.flow.name;
      run.activeNode = undefined;
      await ctx.runStore.putRunState(run);
      return runFlow(transition.flow, run, driver, ctx, agent);
    }

    if (transition.kind === 'end') {
      const park = getFlowPark(run.state);
      if (park && agent) {
        delete run.state.__flowPark;
        const parkedFlow = agent.flows?.find((candidate) => candidate.name === park.flow);
        if (parkedFlow) {
          run.activeFlow = park.flow;
          run.activeNode = park.node;
          await ctx.runStore.putRunState(run);
          ctx.emit({ type: 'flow-end', flow: flow.name, reason: transition.reason });
          return runFlow(parkedFlow, run, driver, ctx, agent);
        }
      }
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
      const escalateNode = findEscalateNode(registry);
      if (escalateNode) {
        appendSafeAssistantMessage(run, ctx);
        await reduceTransition({
          fromNodeId: node.id,
          toNode: escalateNode,
          run,
          flow,
          model: ctx.model,
          data: transition.data,
          emit: ctx.emit,
          abortSignal: ctx.abortSignal,
        });
        await ctx.runStore.putRunState(run);
        node = escalateNode;
        continue;
      }
      appendSafeAssistantMessage(run, ctx);
      ctx.emit({ type: 'flow-end', flow: flow.name, reason: 'error_degraded' });
      return { kind: 'ended', reason: 'error_degraded' };
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
