import type { ModelMessage } from 'ai';
import type { EscalationReason } from '../escalation/types.js';
import type { AgentConfig } from '../types/agentConfig.js';
import type { Flow } from '../types/flow.js';
import type { ChannelDriver, TurnControl } from '../types/channel.js';
import type { RunContext } from '../types/run-context.js';
import type { RunState } from './durable/types.js';
import { clearActiveFlow } from './durable/flowPin.js';
import { runFlow } from '../flow/runFlow.js';
import { resolveReplyNode } from '../flow/nodeBuilders.js';
import { findFlowByName } from '../flows/liveFlowCatalog.js';
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
import { persistTurnUsageFromTurn } from './turnTokenUsage.js';

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
      ctx.emit({ channel: 'client', type: 'error', payload: { error: error.message } });
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
    emit: ctx.emit,
    abortSignal: ctx.abortSignal,
    runStore: ctx.runStore,
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
    // A handoff fired from inside a flow: the source flow is abandoned for this turn.
    // Clear the active-flow pointers so the target agent does not try (and fail) to
    // resume a flow that belongs to the source agent (G17).
    clearActiveFlow(run);
    await ctx.runStore.putRunState(run);
    return { kind: 'handoff', to: result.to, reason: result.reason };
  }

  if (result.kind === 'awaitingUser') {
    await ctx.runStore.putRunState(run);
    return { kind: 'turnComplete' };
  }

  // A flow that ended because a node threw is NOT completed. Marking it so made the
  // failure permanent for the turn: `select` and the host-control tools both exclude a
  // completed flow from re-entry, so a failed intake could not be retried even though the
  // error was recoverable (a mistyped unit id, a transient tool fault). Observed live —
  // a session held __completedFlows: ["raise_work_order"] with an errored journal step
  // and no work order to show for it.
  const degraded = result.kind === 'ended' && result.reason === 'error_degraded';
  if (!degraded) {
    const completed = run.state.__completedFlows;
    const completedFlows = Array.isArray(completed) ? (completed as string[]) : [];
    if (!completedFlows.includes(flow.name)) {
      run.state.__completedFlows = [...completedFlows, flow.name];
    }
  }

  clearActiveFlow(run);
  await ctx.runStore.putRunState(run);

  if (run.verification?.outcome === 'failed-verification') {
    return { kind: 'ended', reason: 'failed-verification' };
  }

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
          emit: ctx.emit.bind(ctx),
          abortSignal: ctx.abortSignal,
          runStore: ctx.runStore,
        })
    : undefined;

  const replyNode = buildAgentReplyNode(agent, run);
  const resolved = resolveReplyNode(replyNode, run.state, { freeConversation: true });
  if (needsGuard) {
    // The driver only buffers/streams per dispatch mode; the guard has a single
    // owner (this loop, on the empty-turn branch below) so it runs at most once.
    resolved.hostControl = { dispatchMode, advisoryDispatch };
  }

  // A binding flow is entered BEFORE the model gets a turn. Offered as `enter_flow`
  // it is one tool among many, and the model reliably converses instead — doing the
  // flow's collecting by hand, so the node's schema and `ask` never execute. Routing
  // decides here; the model does not get the chance to route around it.
  if (startGuard && (agent.flows ?? []).some((flow) => flow.binding)) {
    const bindingVerdict = await startGuard();
    const isBinding =
      bindingVerdict.action === 'enterFlow' &&
      (agent.flows ?? []).some((f) => f.name === bindingVerdict.flowName && f.binding);
    if (isBinding) {
      const control = resolveHostControl(undefined, bindingVerdict, agent, run, false);
      if (control) {
        emitHostGuardTelemetry(ctx, {
          invoked: true,
          reason: 'binding-flow',
          verdict: guardVerdictToTelemetryVerdict(bindingVerdict),
        });
        return await executeHostControl(agent, run, driver, ctx, control);
      }
    }
  }

  const turn = await driver.runAgentTurn(resolved, ctx);
  await persistTurnUsageFromTurn(ctx, turn);

  if (turn.control && isValidControl(turn.control, agent, run)) {
    emitHostGuardTelemetry(ctx, { invoked: false, reason: 'main-control' });
    return await executeHostControl(agent, run, driver, ctx, turn.control);
  }

  if (turn.text.trim()) {
    emitHostGuardTelemetry(ctx, { invoked: false, reason: 'answered' });
    if (turn.toolMessages?.length) {
      run.messages = [...run.messages, ...turn.toolMessages];
    }
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

type HostGuardTelemetryReason =
  | 'answered'
  | 'main-control'
  | 'empty-routed'
  | 'empty-kept'
  /** Routing entered a `binding` flow before the model was given a turn. */
  | 'binding-flow';
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
  ctx.emit({
    channel: 'internal',
    type: 'custom',
    payload: { name: 'host-guard', data },
  });
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
    ctx.emit({
      channel: 'client',
      type: 'error',
      payload: { error: 'No valid host control target resolved' },
    });
    return { kind: 'ended', reason: 'dispatch_failed' };
  }

  if (control.type === 'enterFlow') {
    const flow = findFlowByName(agent, control.flowName);
    if (flow) {
      return await runActiveFlow(flow, run, driver, ctx, agent);
    }
    ctx.emit({
      channel: 'client',
      type: 'error',
      payload: { error: `Flow not found: ${control.flowName}` },
    });
    return { kind: 'ended', reason: 'flow_not_found' };
  }

  if (control.type === 'handoff') {
    ctx.emit({
      channel: 'internal',
      type: 'handoff',
      payload: { targetAgent: control.target, reason: control.reason },
    });
    return { kind: 'handoff', to: control.target, reason: control.reason };
  }

  if (control.type === 'end') {
    return { kind: 'ended', reason: control.reason };
  }

  if (control.type === 'escalate') {
    // No handoff part is emitted here. Runtime owns it: it emits one for any
    // target in `terminalHandoffTargets` (default ['human']) on this exact
    // return value. Emitting here too produced two handoff spans per escalation
    // and a meaningless `human -> human` self-edge, which then mis-attributed
    // every later span in the turn to `human`.
    return { kind: 'handoff', to: 'human', reason: control.reason, category: control.category };
  }

  if (control.type === 'recover') {
    return { kind: 'ended', reason: control.reason ?? 'error_degraded' };
  }

  return { kind: 'turnComplete' };
}
