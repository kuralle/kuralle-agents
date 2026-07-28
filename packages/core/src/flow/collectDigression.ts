import type { ModelMessage } from 'ai';
import type { AgentConfig } from '../types/agentConfig.js';
import type { ChannelDriver } from '../types/channel.js';
import type { ReplyNode } from '../types/flow.js';
import type { RunContext } from '../types/run-context.js';
import type { RunState } from '../runtime/durable/types.js';
import { resolveReplyNode } from './nodeBuilders.js';
import type { NormalizedTransition } from './normalizeTransition.js';
import { selectHostTarget } from '../runtime/select.js';
import { persistTurnUsageFromTurn } from '../runtime/turnTokenUsage.js';

const FLOW_PARK_STACK_KEY = '__flowParkStack';
const LEGACY_FLOW_PARK_KEY = '__flowPark';
const MAX_FLOW_PARK_DEPTH = 8;

export interface FlowPark {
  flow: string;
  node: string;
}

function isFlowPark(raw: unknown): raw is FlowPark {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return false;
  }
  const flow = (raw as FlowPark).flow;
  const node = (raw as FlowPark).node;
  return typeof flow === 'string' && typeof node === 'string';
}

function getFlowParkStack(state: Record<string, unknown>): FlowPark[] | undefined {
  const raw = state[FLOW_PARK_STACK_KEY];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const stack = raw.filter(isFlowPark);
  return stack.length > 0 ? stack : undefined;
}

export function pushFlowPark(state: Record<string, unknown>, park: FlowPark): void {
  const stack = getFlowParkStack(state) ?? [];
  stack.push(park);
  while (stack.length > MAX_FLOW_PARK_DEPTH) {
    stack.shift();
  }
  state[FLOW_PARK_STACK_KEY] = stack;
}

export function popFlowPark(state: Record<string, unknown>): FlowPark | undefined {
  const stack = getFlowParkStack(state);
  if (!stack) {
    return undefined;
  }
  const park = stack.pop();
  if (stack.length === 0) {
    delete state[FLOW_PARK_STACK_KEY];
  } else {
    state[FLOW_PARK_STACK_KEY] = stack;
  }
  return park;
}

export function getFlowPark(state: Record<string, unknown>): FlowPark | undefined {
  const stack = getFlowParkStack(state);
  if (stack) {
    return stack[stack.length - 1];
  }
  const legacy = state[LEGACY_FLOW_PARK_KEY];
  if (isFlowPark(legacy)) {
    return legacy;
  }
  return undefined;
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

  const selection = await select({
    agent,
    run,
    model: agent.routing?.model ?? ctx.controlModel,
    excludeFlowNames: [activeFlowName],
  });

  if (selection.kind === 'route') {
    return {
      kind: 'transition',
      transition: { kind: 'handoff', to: selection.agentId, reason: selection.reason },
    };
  }

  if (selection.kind === 'enterFlow') {
    pushFlowPark(run.state, { flow: activeFlowName, node: node.id });
    return {
      kind: 'transition',
      transition: {
        kind: 'switchFlow',
        flow: selection.flow,
        park: { flow: activeFlowName, node: node.id },
      },
    };
  }

  if (!looksLikeOffScriptQuestion(offScriptInput)) {
    return { kind: 'none' };
  }

  const replyNode: ReplyNode = {
    kind: 'reply',
    id: `${node.id}__digression`,
    instructions:
      ctx.baseInstructions ??
      'Answer the user helpfully and concisely. Do not mention internal routing or flows.',
    tools: ctx.globalTools as ReplyNode['tools'],
    toolScope: 'base',
  };

  const turn = await driver.runAgentTurn(
    resolveReplyNode(replyNode, run.state, { freeConversation: true }),
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
