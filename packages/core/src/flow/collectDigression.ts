import type { ModelMessage } from 'ai';
import type { AgentConfig } from '../types/agentConfig.js';
import type { ChannelDriver } from '../types/channel.js';
import type { ReplyNode } from '../types/flow.js';
import type { RunContext } from '../types/run-context.js';
import type { PersistedFlowPark, RunState } from '../runtime/durable/types.js';
import { buildToolSet } from '../tools/effect/defineTool.js';
import { resolveReplyNode } from './nodeBuilders.js';
import type { NormalizedTransition } from './normalizeTransition.js';
import { selectHostTarget } from '../runtime/select.js';
import type { HostSelection } from '../runtime/select.js';
import { hasHostControlTargets } from '../runtime/hostControlTools.js';
import { persistTurnUsageFromTurn } from '../runtime/turnTokenUsage.js';
import { currentFlowState } from './flowState.js';

export const MAX_FLOW_PARK_DEPTH = 8;

/** Runaway nested flow entry. The structural twin of `FlowOscillationError`, and degraded
 *  the same way — a bounded limit the framework absorbs, not a crash the caller handles. */
export class FlowParkOverflowError extends Error {
  constructor(depth: number) {
    super(`Flow park depth exceeds ${depth}`);
    this.name = 'FlowParkOverflowError';
  }
}

export type FlowPark = PersistedFlowPark;

export function pushFlowPark(run: RunState, park: FlowPark): void {
  const stack = run.flowStack ?? [];
  if (stack.length >= MAX_FLOW_PARK_DEPTH) {
    throw new FlowParkOverflowError(MAX_FLOW_PARK_DEPTH);
  }
  stack.push(park);
  run.flowStack = stack;
}

export function popFlowPark(run: RunState): FlowPark | undefined {
  const stack = run.flowStack;
  if (!stack?.length) return undefined;
  const park = stack.pop();
  if (stack.length === 0) {
    run.flowStack = undefined;
  }
  return park;
}

export function getFlowPark(run: RunState): FlowPark | undefined {
  return run.flowStack?.at(-1);
}

function appendAssistantMessage(run: RunState, text: string): void {
  if (!text.trim()) {
    return;
  }
  const message: ModelMessage = { role: 'assistant', content: text };
  run.messages = [...run.messages, message];
}

export function looksLikeOffScriptQuestion(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.includes('?')) {
    return true;
  }
  return /^(what|how|why|when|where|who|can|could|do|does|is|are|will|would)\b/i.test(trimmed);
}

export interface CollectDigressionOptions {
  agent: AgentConfig;
  node: { id: string };
  activeFlowName: string;
  run: RunState;
  driver: ChannelDriver;
  ctx: RunContext;
  select?: typeof selectHostTarget;
}

export type CollectDigressionResult =
  | { kind: 'transition'; transition: NormalizedTransition }
  | { kind: 'answeredThenResume' }
  | { kind: 'none' };

export async function runCollectDigression(
  options: CollectDigressionOptions,
): Promise<CollectDigressionResult> {
  const { agent, node, activeFlowName, run, driver, ctx } = options;
  const select = options.select ?? selectHostTarget;
  const offScriptInput = peekLatestUserMessage(run);
  if (!offScriptInput) {
    return { kind: 'none' };
  }

  const bindingFlow = agent.flows?.some(
    (flow) => flow.name === activeFlowName && flow.binding,
  );
  let selection: HostSelection = { kind: 'keep' };
  if (!bindingFlow || options.select || hasHostControlTargets(agent, run)) {
    selection = await select({
      agent,
      run,
      model: agent.routing?.model ?? ctx.controlModel,
      ...(bindingFlow ? {} : { excludeFlowNames: [activeFlowName] }),
      emit: ctx.emit,
      abortSignal: ctx.abortSignal,
      runStore: ctx.runStore,
    });
  }

  // Entering another flow still wins: a mid-intake "can you dispatch a vendor?" is a
  // question, but it belongs to a flow, so route it rather than answering it inline.
  if (selection.kind === 'enterFlow') {
    if (selection.flow.name === activeFlowName) {
      return { kind: 'none' };
    }
    return {
      kind: 'transition',
      transition: {
        kind: 'switchFlow',
        flow: selection.flow,
        park: { flow: activeFlowName, node: node.id },
      },
    };
  }

  // An answerable aside is answered here, BEFORE the router's transfer verdict is
  // honoured. Ordered the other way round, `route` returned first and this test was
  // unreachable: an ordinary "who's the cheapest plumber?" mid-flow handed the caller
  // to a human and discarded everything already collected. Transfer is for input that
  // is not a question the agent can simply answer.
  if (!looksLikeOffScriptQuestion(offScriptInput)) {
    if (selection.kind === 'route') {
      return {
        kind: 'transition',
        transition: { kind: 'handoff', to: selection.agentId, reason: selection.reason },
      };
    }
    return { kind: 'none' };
  }

  const replyNode: ReplyNode = {
    kind: 'reply',
    id: `${node.id}__digression`,
    instructions:
      ctx.baseInstructions ??
      'Answer the user helpfully and concisely. Do not mention internal routing or flows.',
    // `ctx.globalTools` holds RAW tool definitions; `ReplyNode.tools` is a built
    // ToolSet. Casting between them handed Zod schemas to the provider as if they
    // were AI SDK tools ("Invalid schema for function 'list_units'"). It went
    // unnoticed because the router short-circuited before this node ever ran.
    tools: buildToolSet(ctx.globalTools ?? {}),
    toolScope: 'base',
  };

  const turn = await driver.runAgentTurn(
    resolveReplyNode(replyNode, currentFlowState(run), { freeConversation: true }),
    ctx,
  );
  await persistTurnUsageFromTurn(ctx, turn);

  if (turn.text.trim()) {
    appendAssistantMessage(run, turn.text);
  }

  if (turn.control?.type === 'handoff') {
    return {
      kind: 'transition',
      transition: { kind: 'handoff', to: turn.control.target, reason: turn.control.reason },
    };
  }

  return { kind: 'answeredThenResume' };
}

function peekLatestUserMessage(run: RunState): string | undefined {
  for (let i = run.messages.length - 1; i >= 0; i -= 1) {
    const message = run.messages[i];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return undefined;
}
