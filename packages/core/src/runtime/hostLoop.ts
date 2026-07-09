import type { ModelMessage } from 'ai';
import type { EscalationReason } from '../escalation/types.js';
import type { AgentConfig } from '../types/agentConfig.js';
import type { Flow } from '../types/flow.js';
import type { ChannelDriver, TurnControl } from '../types/channel.js';
import type { RunContext } from '../types/run-context.js';
import type { RunState } from './durable/types.js';
import { runFlow } from '../flow/runFlow.js';
import { resolveReplyNode } from '../flow/nodeBuilders.js';
import { SuspendError } from './durable/RunStore.js';
import { buildAgentReplyNode } from './agentReply.js';
import { deriveAgentShape } from './deriveAgent.js';
import {
  assertWithinTurnLimit,
  incrementTurnCount,
  LimitsExceededError,
} from './policies/limits.js';
import {
  classifyHostTarget,
  verdictToSelection,
  type ClassifyHostOptions,
  type HostGuardVerdict,
} from './select.js';
import { hasHostControlTargets } from './hostControlTools.js';
import {
  isValidControl,
  resolveHostControl,
  startHostControlGuard,
} from './hostControlGuard.js';
import { resolveDispatchMode, isAdvisoryDispatch } from './dispatchMode.js';
import { adaptHostSelect } from './hostClassifyAdapter.js';
import type { selectHostTarget } from './select.js';

export type HostLoopResult =
  | { kind: 'handoff'; to: string; reason?: string; category?: EscalationReason }
  | { kind: 'ended'; reason: string }
  | { kind: 'paused' }
  | { kind: 'turnComplete' };

export interface HostLoopOptions {
  agent: AgentConfig;
  run: RunState;
  driver: ChannelDriver;
  ctx: RunContext;
  classify?: (opts: ClassifyHostOptions) => Promise<HostGuardVerdict>;
  /** @deprecated Test injection — use classify. */
  select?: typeof selectHostTarget;
}

export async function hostLoop(options: HostLoopOptions): Promise<HostLoopResult> {
  const { agent, run, driver, ctx } = options;
  const classify =
    options.classify ??
    (options.select ? adaptHostSelect(options.select) : classifyHostTarget);

  try {
    if (run.activeFlow) {
      const flow = findFlowByName(agent, run.activeFlow);
      if (!flow) {
        throw new Error(`Active flow "${run.activeFlow}" not found on agent "${agent.id}"`);
      }
      return await runActiveFlow(flow, run, driver, ctx, agent);
    }

    const shape = deriveAgentShape(agent);

    if (shape.isPureDispatcher) {
      return await runPureDispatcher(agent, run, driver, ctx, classify);
    }

    if (shape.isAnsweringAgent) {
      return await runAnsweringAgent(agent, run, driver, ctx, classify);
    }

    return await runFreeConversation(agent, run, driver, ctx, classify);
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

async function runPureDispatcher(
  agent: AgentConfig,
  run: RunState,
  driver: ChannelDriver,
  ctx: RunContext,
  classify: (opts: ClassifyHostOptions) => Promise<HostGuardVerdict>,
): Promise<HostLoopResult> {
  incrementTurnCount(run);
  assertWithinTurnLimit(run, ctx.limits);

  const model = agent.routing?.model ?? ctx.controlModel;
  const verdict = await classify({
    agent,
    run,
    model,
    allowKeep: false,
  });

  return await executeHostControl(agent, run, driver, ctx, guardVerdictToControl(verdict, agent));
}

async function runAnsweringAgent(
  agent: AgentConfig,
  run: RunState,
  driver: ChannelDriver,
  ctx: RunContext,
  classify: (opts: ClassifyHostOptions) => Promise<HostGuardVerdict>,
): Promise<HostLoopResult> {
  return await runFreeConversation(agent, run, driver, ctx, classify);
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

  // Anchor durable effect callsites to the flow. On a fresh entry the answering
  // turn may have consumed callsites (enter_flow / tool calls); on resume that
  // turn does not re-run. Rebasing here makes the flow's callsites (and any
  // suspend/resume key) identical across both paths, so a resumed run does not
  // re-suspend on a callsite mismatch.
  ctx.resetCallsites();

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
  classify: (opts: ClassifyHostOptions) => Promise<HostGuardVerdict>,
): Promise<HostLoopResult> {
  const shape = deriveAgentShape(agent);
  if (!shape.isAnsweringAgent) {
    return { kind: 'turnComplete' };
  }

  incrementTurnCount(run);
  assertWithinTurnLimit(run, ctx.limits);

  const capability = driver.outputCapability ?? 'kuralle-controlled-text';
  const dispatchMode = resolveDispatchMode(agent, capability);
  const advisoryDispatch = isAdvisoryDispatch(capability);
  const needsGuard = hasHostControlTargets(agent, run);
  const controlModel = agent.routing?.model ?? ctx.controlModel;

  const startGuard = needsGuard
    ? () =>
        startHostControlGuard({
          agent,
          run,
          model: controlModel,
          classify,
        })
    : undefined;

  const replyNode = buildAgentReplyNode(agent, run);
  const resolved = resolveReplyNode(replyNode, run.state, { freeConversation: true });
  if (needsGuard) {
    // The driver only buffers/streams per dispatch mode; the guard has a single
    // owner (this loop, on the empty-turn branch below) so it runs at most once.
    resolved.hostControl = { dispatchMode, advisoryDispatch };
  }

  const turn = await driver.runAgentTurn(resolved, ctx);

  if (turn.control && isValidControl(turn.control, agent, run)) {
    emitHostGuardTelemetry(ctx, { invoked: false, reason: 'main-control' });
    return await executeHostControl(agent, run, driver, ctx, turn.control);
  }

  if (turn.text.trim()) {
    emitHostGuardTelemetry(ctx, { invoked: false, reason: 'answered' });
    const message: ModelMessage = { role: 'assistant', content: turn.text };
    run.messages = [...run.messages, message];
    await ctx.runStore.putRunState(run);
    return { kind: 'turnComplete' };
  }

  if (startGuard) {
    const guardVerdict = await startGuard();
    const control = resolveHostControl(undefined, guardVerdict, agent, run, false);
    if (control) {
      emitHostGuardTelemetry(ctx, {
        invoked: true,
        reason: 'empty-routed',
        verdict: guardVerdictToTelemetryVerdict(guardVerdict),
      });
      return await executeHostControl(agent, run, driver, ctx, control);
    }
    emitHostGuardTelemetry(ctx, {
      invoked: true,
      reason: 'empty-kept',
      verdict: guardVerdictToTelemetryVerdict(guardVerdict),
    });
  }

  return { kind: 'turnComplete' };
}

type HostGuardTelemetryReason = 'answered' | 'main-control' | 'empty-routed' | 'empty-kept';
type HostGuardTelemetryVerdict = 'keep' | 'enterFlow' | 'transfer';

function guardVerdictToTelemetryVerdict(verdict: HostGuardVerdict): HostGuardTelemetryVerdict {
  if (verdict.action === 'enterFlow') return 'enterFlow';
  if (verdict.action === 'transfer') return 'transfer';
  return 'keep';
}

function emitHostGuardTelemetry(
  ctx: RunContext,
  data: {
    invoked: boolean;
    reason: HostGuardTelemetryReason;
    verdict?: HostGuardTelemetryVerdict;
  },
): void {
  ctx.emit({ type: 'custom', name: 'host-guard', data });
}

function guardVerdictToControl(
  verdict: HostGuardVerdict,
  agent: AgentConfig,
): TurnControl | undefined {
  const selection = verdictToSelection(verdict, agent);
  if (!selection || selection.kind === 'keep') {
    return undefined;
  }
  if (selection.kind === 'enterFlow') {
    return { type: 'enterFlow', flowName: selection.flow.name };
  }
  return { type: 'handoff', target: selection.agentId, reason: selection.reason };
}

async function executeHostControl(
  agent: AgentConfig,
  run: RunState,
  driver: ChannelDriver,
  ctx: RunContext,
  control: TurnControl | undefined,
): Promise<HostLoopResult> {
  if (!control) {
    ctx.emit({ type: 'error', error: 'No valid host control target resolved' });
    return { kind: 'ended', reason: 'dispatch_failed' };
  }

  if (control.type === 'enterFlow') {
    const flow = findFlowByName(agent, control.flowName);
    if (flow) {
      return await runActiveFlow(flow, run, driver, ctx, agent);
    }
    ctx.emit({ type: 'error', error: `Flow not found: ${control.flowName}` });
    return { kind: 'ended', reason: 'flow_not_found' };
  }

  if (control.type === 'handoff') {
    ctx.emit({ type: 'handoff', targetAgent: control.target, reason: control.reason });
    return { kind: 'handoff', to: control.target, reason: control.reason };
  }

  if (control.type === 'end') {
    return { kind: 'ended', reason: control.reason };
  }

  if (control.type === 'escalate') {
    ctx.emit({ type: 'handoff', targetAgent: 'human', reason: control.reason });
    return { kind: 'handoff', to: 'human', reason: control.reason, category: control.category };
  }

  if (control.type === 'recover') {
    return { kind: 'ended', reason: control.reason ?? 'error_degraded' };
  }

  return { kind: 'turnComplete' };
}

function findFlowByName(agent: AgentConfig, flowName: string): Flow | undefined {
  return agent.flows?.find((flow) => flow.name === flowName);
}
