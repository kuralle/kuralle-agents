import type { ModelMessage } from 'ai';
import type { AgentConfig } from '../types/agentConfig.js';
import type { Flow } from '../types/flow.js';
import type { ChannelDriver } from '../types/channel.js';
import type { RunContext } from '../types/run-context.js';
import type { RunState } from './durable/types.js';
import { runFlow } from '../flow/runFlow.js';
import { resolveReplyNode } from '../flow/nodeBuilders.js';
import { SuspendError } from './durable/RunStore.js';
import { buildAgentReplyNode } from './agentReply.js';
import { deriveAgentCapabilities, shouldRunHostSelector } from './deriveAgent.js';
import { selectHostTarget } from './select.js';
import {
  assertWithinTurnLimit,
  incrementTurnCount,
  LimitsExceededError,
} from './policies/limits.js';

export type HostLoopResult =
  | { kind: 'handoff'; to: string; reason?: string }
  | { kind: 'ended'; reason: string }
  | { kind: 'paused' }
  | { kind: 'turnComplete' };

export interface HostLoopOptions {
  agent: AgentConfig;
  run: RunState;
  driver: ChannelDriver;
  ctx: RunContext;
  select?: typeof selectHostTarget;
}

export async function hostLoop(options: HostLoopOptions): Promise<HostLoopResult> {
  const { agent, run, driver, ctx } = options;
  const select = options.select ?? selectHostTarget;

  try {
    if (run.activeFlow) {
      const flow = findFlowByName(agent, run.activeFlow);
      if (!flow) {
        throw new Error(`Active flow "${run.activeFlow}" not found on agent "${agent.id}"`);
      }
      return await runActiveFlow(flow, run, driver, ctx, agent);
    }

    const alwaysRoute = agent.routing?.always === true;
    if (shouldRunHostSelector(agent, run.activeFlow, alwaysRoute)) {
      const selection = await select({
        agent,
        run,
        model: agent.routing?.model ?? ctx.controlModel,
        alwaysRoute,
      });

      if (selection.kind === 'enterFlow') {
        return await runActiveFlow(selection.flow, run, driver, ctx, agent);
      }

      if (selection.kind === 'route') {
        ctx.emit({ type: 'handoff', targetAgent: selection.agentId, reason: selection.reason });
        return { kind: 'handoff', to: selection.agentId, reason: selection.reason };
      }
    }

    return await runFreeConversation(agent, run, driver, ctx);
  } catch (error) {
    if (error instanceof SuspendError) {
      return { kind: 'paused' };
    }
    if (error instanceof LimitsExceededError) {
      ctx.emit({ type: 'error', error: error.message });
      return { kind: 'ended', reason: error.message };
    }
    throw error;
  }
}

async function runActiveFlow(
  flow: Flow,
  run: RunState,
  driver: ChannelDriver,
  ctx: RunContext,
  agent: AgentConfig,
): Promise<HostLoopResult> {
  incrementTurnCount(run);
  assertWithinTurnLimit(run, ctx.limits);

  const result = await runFlow(flow, run, driver, ctx, agent);

  if (result.kind === 'handoff') {
    return { kind: 'handoff', to: result.to, reason: result.reason };
  }

  if (result.kind === 'awaitingUser') {
    await ctx.runStore.putRunState(run);
    return { kind: 'turnComplete' };
  }

  const completed = run.state.__completedFlows;
  const completedFlows = Array.isArray(completed) ? (completed as string[]) : [];
  if (!completedFlows.includes(flow.name)) {
    run.state.__completedFlows = [...completedFlows, flow.name];
  }

  run.activeFlow = undefined;
  run.activeNode = undefined;
  await ctx.runStore.putRunState(run);

  return { kind: 'turnComplete' };
}

async function runFreeConversation(
  agent: AgentConfig,
  run: RunState,
  driver: ChannelDriver,
  ctx: RunContext,
): Promise<HostLoopResult> {
  const caps = deriveAgentCapabilities(agent);
  if (!caps.hasFreeConversation && !agent.tools) {
    return { kind: 'turnComplete' };
  }

  incrementTurnCount(run);
  assertWithinTurnLimit(run, ctx.limits);

  const replyNode = buildAgentReplyNode(agent);
  const turn = await driver.runAgentTurn(
    resolveReplyNode(replyNode, run.state, { freeConversation: true }),
    ctx,
  );

  if (turn.text.trim()) {
    const message: ModelMessage = { role: 'assistant', content: turn.text };
    run.messages = [...run.messages, message];
    await ctx.runStore.putRunState(run);
  }

  if (turn.control?.type === 'handoff') {
    ctx.emit({ type: 'handoff', targetAgent: turn.control.target, reason: turn.control.reason });
    return { kind: 'handoff', to: turn.control.target, reason: turn.control.reason };
  }

  if (turn.control?.type === 'end') {
    return { kind: 'ended', reason: turn.control.reason };
  }

  if (turn.control?.type === 'escalate') {
    ctx.emit({ type: 'handoff', targetAgent: 'human', reason: turn.control.reason });
    return { kind: 'handoff', to: 'human', reason: turn.control.reason };
  }

  if (turn.control?.type === 'recover') {
    return { kind: 'ended', reason: turn.control.reason ?? 'error_degraded' };
  }

  return { kind: 'turnComplete' };
}

function findFlowByName(agent: AgentConfig, flowName: string): Flow | undefined {
  return agent.flows?.find((flow) => flow.name === flowName);
}
