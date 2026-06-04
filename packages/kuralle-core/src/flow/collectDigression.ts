import type { ModelMessage } from 'ai';
import type { AgentConfig } from '../types/agentConfig.js';
import type { ChannelDriver } from '../types/channel.js';
import type { CollectNode, ReplyNode } from '../types/flow.js';
import type { RunContext } from '../types/run-context.js';
import type { RunState } from '../runtime/durable/types.js';
import { resolveReplyNode } from './nodeBuilders.js';
import type { NormalizedTransition } from './normalizeTransition.js';
import { selectHostTarget } from '../runtime/select.js';

const FLOW_PARK_KEY = '__flowPark';

export interface FlowPark {
  flow: string;
  node: string;
}

export function getFlowPark(state: Record<string, unknown>): FlowPark | undefined {
  const raw = state[FLOW_PARK_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const flow = (raw as FlowPark).flow;
  const node = (raw as FlowPark).node;
  if (typeof flow === 'string' && typeof node === 'string') {
    return { flow, node };
  }
  return undefined;
}

function setFlowPark(state: Record<string, unknown>, park: FlowPark): void {
  state[FLOW_PARK_KEY] = park;
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
  node: CollectNode;
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
    alwaysRoute: agent.routing?.always === true,
    excludeFlowNames: [activeFlowName],
  });

  if (selection.kind === 'route') {
    return {
      kind: 'transition',
      transition: { kind: 'handoff', to: selection.agentId, reason: selection.reason },
    };
  }

  if (selection.kind === 'enterFlow') {
    setFlowPark(run.state, { flow: activeFlowName, node: node.id });
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
  };

  const turn = await driver.runAgentTurn(
    resolveReplyNode(replyNode, run.state, { freeConversation: true }),
    ctx,
  );

  if (turn.text.trim()) {
    ctx.emit({ type: 'text-delta', text: turn.text });
    ctx.emit({ type: 'turn-end' });
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
