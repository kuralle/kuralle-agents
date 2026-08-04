import { randomUUID } from 'node:crypto';
import type { LanguageModel, ModelMessage, TranscriptionModel } from 'ai';
import type { UserInputContent } from './userInput.js';
import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { AuditListOptions, ConversationAuditEntry } from '../audit/types.js';
import { filterAuditEntries } from '../audit/filterAuditEntries.js';
import type { AgentConfig } from '../types/agentConfig.js';
import type { ChannelDriver } from '../types/channel.js';
import type { Hooks } from '../types/hooks.js';
import type { Tool, AnyTool } from '../types/effectTool.js';
import type { TurnResult } from '../types/channel.js';
import type { StreamPart, TurnHandle } from '../types/stream.js';
import type { SignalDelivery } from './durable/types.js';
import type { ResolvedSelection } from '../types/selection.js';
import type { ConversationOutcome, ConversationOutcomeMarkedBy } from '../outcomes/types.js';
import type { DeploymentTraceContext } from '../types/trace.js';
import { MemoryStore } from '../session/stores/MemoryStore.js';
import { TextDriver } from './channels/TextDriver.js';
import { createRunContext } from './ctx.js';
import { createEventBus, createTurnHandle } from '../events/TurnHandle.js';
import { CoreToolExecutor } from '../tools/effect/index.js';
import { buildAgentToolSurface } from './buildAgentToolSurface.js';
import { createNoSkillsGetSkill } from '../skills/skillHandle.js';
import { hostLoop, type HostLoopResult } from './hostLoop.js';
import { isHandoffOscillating } from './handoffOscillation.js';
import { applyHandoffContinuation } from './handoffContinuation.js';
import { isDegradableRuntimeError } from '../flow/degradableErrors.js';
import { SAFE_DEGRADED_MESSAGE } from '../flow/degrade.js';

import type { classifyHostTarget, selectHostTarget } from './select.js';
import { adaptHostSelect } from './hostClassifyAdapter.js';
import { openRun, sessionDerivedRunId } from './openRun.js';

function resolveOutOfBandControl(agent: AgentConfig): boolean {
  const hasFlows = (agent.flows?.length ?? 0) > 0;
  return agent.experimental?.outOfBandControl ?? hasFlows;
}
import { closeRun } from './closeRun.js';
import { SessionRunStore } from './durable/SessionRunStore.js';
import { loadRecordedSteps } from './durable/replay.js';
import { markSessionOutcome } from './outcomeMarking.js';
import { resolveAgentPolicies } from './policies/resolvePolicies.js';
import type { KnowledgeProviderConfig } from '../types/knowledge.js';
import type { MemoryService as V1MemoryService } from '../memory/MemoryService.js';
import {
  buildAutoRetrieveProvider,
  buildKnowledgeProvider,
  buildMemoryService,
  runMemoryIngest,
} from './grounding/index.js';
import type { PersistentMemoryStore } from '../memory/blocks/types.js';
import { SessionMutex } from './SessionMutex.js';
import { compactMessages, type CompactionConfig } from './compaction.js';
import {
  readLastPromptTokens,
  readCumulativeUsage,
  computeTurnTraceUsage,
  resetTurnPeakPromptTokens,
} from './turnTokenUsage.js';
import { isContextOverflowError, recoverFromContextOverflow } from './contextOverflow.js';
import { projectGoalsPromptFromState, updateGoalsFromTurn } from './goals.js';
import type { RunContext } from '../types/run-context.js';
import type { EscalationConfig, EscalationOutcome, EscalationReason } from '../escalation/types.js';
import {
  buildEscalationRequest,
  recordEscalationOutcome,
  ESCALATION_NOTIFIED_KEY,
} from '../escalation/escalation.js';
import type { WakeOptions } from '../scheduler/index.js';
import type { HandoffInputFilter } from './handoffFilters.js';
import { runOnce as recordRunOnce } from './TraceRecorder.js';
import { TraceRecorder } from './TraceRecorder.js';
import type { AgentSpan, AgentTrace } from '../types/trace.js';
import { MemoryTraceStore } from '../tracing/MemoryTraceStore.js';
import { mutateSessionWithRetry } from '../session/utils.js';
import { isTraceStore, type TraceSink, type TraceStore } from '../tracing/TraceStore.js';
import { runHookSafely } from './runHookSafely.js';
import { addSystemNote } from './systemNotes.js';
import { needsApprovalPolicy, composePolicies, type Policy } from './policies/toolPolicy.js';
import {
  skillRestrictionPolicy,
  type SkillActivation,
} from '../skills/skillActivation.js';
import { currentFlowState } from '../flow/flowState.js';
import { resolveReplyNode } from '../flow/nodeBuilders.js';
/**
 * What the user is told when the run hands off to a human and the app has not configured an
 * escalation handler to say something better. Silence is the wrong default: an escalation
 * that emits no text is indistinguishable from the agent having crashed.
 */
export const HANDOFF_TO_HUMAN_MESSAGE =
  "I'm bringing a colleague into this — they'll pick it up from here.";

/**
 * What the user is told on any turn that arrives WHILE a run is already held for a human.
 * The agent does not re-run for these turns — without a live `kuralle resume` the session
 * would otherwise re-escalate every message regardless of topic. Distinct from
 * `HANDOFF_TO_HUMAN_MESSAGE`, which is the one-time notice emitted on the escalating turn.
 */
export const HELD_FOR_HUMAN_MESSAGE =
  "A colleague is already handling this — I'll pick it back up as soon as they're done.";

export interface TracingConfig {
  enabled?: boolean;
  store?: TraceStore;
  sinks?: TraceSink[];
  redact?: (span: AgentSpan) => AgentSpan | null;
  sampling?: number | ((context: { sessionId: string; input?: unknown }) => boolean);
}

export interface HarnessConfig {
  agents: AgentConfig[];
  defaultAgentId: string;
  /** Default channel driver for every run. `RunOptions.driver` overrides it per call. */
  driver?: ChannelDriver;
  sessionStore?: SessionStore;
  defaultModel?: LanguageModel;
  maxHandoffs?: number;
  terminalHandoffTargets?: string[];
  hooks?: Hooks;
  voiceMode?: boolean;
  hostClassify?: typeof classifyHostTarget;
  /** @deprecated Use hostClassify — test injection adapter for HostSelection stubs. */
  hostSelect?: typeof selectHostTarget;
  tools?: Record<string, AnyTool>;
  knowledge?: KnowledgeProviderConfig;
  memoryService?: V1MemoryService;
  /** Default store for `agent.memory.workingMemory` when `workingMemory.store` is omitted. */
  defaultWorkingMemoryStore?: PersistentMemoryStore;
  /**
   * Optional AI SDK transcription model. When set, inbound audio file parts (voice
   * notes) are transcribed to text before the model turn — so voice input works on
   * text-only models. When omitted, audio parts pass through to audio-capable models.
   */
  transcriptionModel?: TranscriptionModel;
  /**
   * Automatic history compaction. When set, the runtime summarizes older
   * messages into one system note after any turn whose history exceeds
   * `triggerTokens` (off the user's latency path), and force-compacts once as
   * the retry step after a provider context-overflow error.
   */
  compaction?: CompactionConfig;
  /**
   * Escalation-to-human pipeline. When set, any escalation — a terminal
   * handoff (`handoffs: ['human']`, validator `escalate` decision, host
   * control) or a flow `escalate()` pause — builds an `EscalationRequest`
   * (state snapshot + recent messages + optional LLM handoff brief) and
   * invokes the handler. Resume with `runtime.resumeFromEscalation()`.
   */
  escalation?: EscalationConfig;
  /** Default handoff input filter when a route does not define `filter`. */
  handoffInputFilter?: HandoffInputFilter;
  /**
   * Silent handoff (default `true`). A transfer between agents reads as one
   * continuous assistant: the transfer is a silent control tool call, and the
   * target is given a continuation directive so it does not greet or
   * re-introduce itself. Set `false` for an explicit visible transfer (the
   * target follows its own instructions, e.g. "Bill here").
   */
  silentHandoff?: boolean;
  /**
   * Structured goal/thread tracking (G5). When enabled, a cheap control-model
   * pass at turn end patches `session.workingMemory.__goals` and open threads
   * are projected into the next turn's prompt. Default off — opt-in cost/latency.
   */
  trackGoals?: boolean;
  /**
   * Default decision for every tool call, when the agent does not supply its own.
   * Omitted, tools honour `needsApproval` exactly as before.
   */
  policy?: Policy;
  /** Read-only observability, configured independently from durable session state. */
  tracing?: TracingConfig;
}

export interface RunOptions {
  sessionId?: string;
  /** The user turn: plain text, or AI SDK multimodal content (text + file/image/audio parts). */
  input?: UserInputContent;
  selection?: ResolvedSelection;
  /**
   * Agent-initiated (proactive) turn — mutually exclusive with `input`. The
   * runtime appends a wake note instead of a user message and runs the normal
   * loop: free-conversation agents proactively re-engage; an active flow
   * re-prompts its current step. Schedule wakes with `createWakeJobRunner`.
   */
  wake?: WakeOptions;
  userId?: string;
  agentId?: string;
  seedMessages?: ModelMessage[];
  historyDelta?: ModelMessage[];
  driver?: ChannelDriver;
  signalDelivery?: SignalDelivery;
  /** Stable key for this inbound user message; duplicate webhook retries are ignored (H2). */
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
  /** Immutable release identity already authorized and pinned by the deployment host. */
  deployment?: DeploymentTraceContext;
}

export class Runtime {
  private readonly agentsById: Map<string, AgentConfig>;
  private readonly sessionStore: SessionStore;
  private readonly defaultModel?: LanguageModel;
  private readonly maxHandoffs: number;
  private readonly terminalHandoffTargets: Set<string>;
  private readonly hooks?: Hooks;
  private readonly activeTurnAborts = new Map<string, AbortController>();
  private readonly sessionMutex = new SessionMutex();
  private readonly traceStore?: TraceStore;
  private readonly traceSinks: TraceSink[];
  private readonly pendingTraceWrites = new Set<Promise<void>>();

  constructor(private readonly config: HarnessConfig) {
    this.agentsById = indexAgents(config.agents);
    this.sessionStore = config.sessionStore ?? new MemoryStore();
    this.defaultModel = config.defaultModel;
    this.maxHandoffs = config.maxHandoffs ?? 5;
    this.terminalHandoffTargets = new Set(config.terminalHandoffTargets ?? ['human']);
    this.hooks = config.hooks;
    const configuredSinks = config.tracing?.sinks ?? [];
    const configuredStore = config.tracing?.store ?? configuredSinks.find(isTraceStore);
    this.traceStore = config.tracing?.enabled === false
      ? undefined
      : configuredStore ?? new MemoryTraceStore();
    this.traceSinks = this.traceStore
      ? [this.traceStore, ...configuredSinks.filter((sink) => sink !== this.traceStore)]
      : [];
  }

  run(opts: RunOptions): TurnHandle {
    if (opts.wake && opts.input !== undefined) {
      throw new Error('RunOptions.wake and RunOptions.input are mutually exclusive');
    }
    const sessionId = opts.sessionId || randomUUID();
    const recorder = this.shouldTrace(sessionId, opts.input)
      ? new TraceRecorder({
          sessionId,
          agentId: opts.agentId ?? this.config.defaultAgentId,
          input: opts.input,
          deployment: opts.deployment,
          onSpan: (span) => this.writeSpan(span),
        })
      : undefined;
    const bus = createEventBus();
    const abortController = new AbortController();
    this.activeTurnAborts.set(sessionId, abortController);
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const execute = async (): Promise<TurnResult> => {
      let runCtx!: import('../types/run-context.js').RunContext;
      // Whether the user has been told anything at all this turn. A terminal handoff with
      // no escalation handler configured used to emit zero text — seven consecutive turns
      // were observed producing empty output while silently firing transfer_to_agent, which
      // is indistinguishable from an outage.
      let sawUserText = false;
      // Handoff targets already announced this turn. `hostLoop` emits a handoff part when
      // the transfer control tool fires, and the terminal branch below emits one too —
      // but only SOME terminal handoffs come through hostLoop's control path (a validator
      // escalate does not), so neither emitter can be deleted. Deduplicate instead: the
      // double emit produced a spurious `human -> human` self-edge in the trace, because
      // by the second emit the recorder's current agent was already the target.
      const announcedHandoffs = new Set<string>();
      const emit = (part: StreamPart) => {
        if (part.type === 'text-delta' && part.payload.delta) sawUserText = true;
        if (part.type === 'handoff') announcedHandoffs.add(part.payload.targetAgent);
        recorder?.record(part);
        if (part.type === 'done') this.flushTraceSinks();
        bus.emit(part);
        void runHookSafely('onStreamPart', () => this.hooks?.onStreamPart?.(runCtx, part));
      };

      const opened = await openRun(this.agentsById, {
        sessionId,
        userId: opts.userId,
        input: opts.input,
        selection: opts.selection,
        wake: opts.wake,
        agentId: opts.agentId,
        seedMessages: opts.seedMessages,
        historyDelta: opts.historyDelta,
        signalDelivery: opts.signalDelivery,
        idempotencyKey: opts.idempotencyKey,
        transcriptionModel: this.config.transcriptionModel,
        defaultAgentId: this.config.defaultAgentId,
        sessionStore: this.sessionStore,
      });
      // `appendConversationAudit` writes into the live session during the turn.
      // Stores with a dedicated audit log need only the entries created by this
      // turn, not the complete inline history loaded with the session.
      const auditBaseline = opened.session.metadata?.audit?.length ?? 0;
      recorder?.setInitiatingAgent(opened.agent.id);

      const policies = resolveAgentPolicies(opened.agent);
      const knowledgeProvider = this.config.knowledge
        ? buildKnowledgeProvider(this.config.knowledge)
        : undefined;
      const openingSurface = await buildAgentToolSurface(opened.agent, opened.session, {
        configTools: this.config.tools,
        knowledgeProvider,
        defaultWorkingMemoryStore: this.config.defaultWorkingMemoryStore,
      });
      if (openingSurface.skillContentHash) {
        recorder?.recordSkillSnapshot(opened.agent.id, openingSurface.skillContentHash);
      }

      const toolExecutor = new CoreToolExecutor({
        tools: openingSurface.executorTools,
        enforcer: policies.enforcer,
        agentId: opened.agent.id,
        onInterim: (message) => {
          const id = crypto.randomUUID();
          emit({ channel: 'client', type: 'text-start', payload: { id } });
          emit({ channel: 'client', type: 'text-delta', payload: { id, delta: message } });
          emit({ channel: 'client', type: 'text-end', payload: { id } });
        },
        onChunk: (chunk, toolName, toolCallId) => {
          emit({
            channel: 'internal',
            type: 'tool-result',
            payload: { toolName, result: chunk, toolCallId, preliminary: true },
          });
        },
      });
      const steps = await loadRecordedSteps(opened.runStore, opened.runState.runId);
      const freshRunState =
        (await opened.runStore.getRunState(opened.runState.runId)) ?? opened.runState;
      if (
        opts.signalDelivery &&
        !steps.some((step) => step.signalId === opts.signalDelivery!.signalId)
      ) {
        const waitingFor = freshRunState.waitingFor;
        if (
          !waitingFor ||
          waitingFor.signalName !== opts.signalDelivery.name ||
          waitingFor.requestId !== opts.signalDelivery.requestId
        ) {
          throw new Error(
            `Signal ${opts.signalDelivery.name}/${opts.signalDelivery.requestId} does not match waitingFor ` +
              `${waitingFor ? `${waitingFor.signalName}/${waitingFor.requestId}` : 'none'}`,
          );
        }
      }
      // Snapshot cumulative token usage as this turn opens, so the trace can report
      // THIS turn's consumption (delta), not the running session total (see the
      // per-turn scope requirement in the observability guide).
      const usageBaseline = readCumulativeUsage(freshRunState.state);
      resetTurnPeakPromptTokens(freshRunState.state);

      // A run parked on a terminal-handoff escalation (status 'paused' with NO `waitingFor`)
      // is held for a human until `resumeFromEscalation`. It must not re-run the agent —
      // without this gate every later turn re-escalated, recycling the prior escalation's
      // reason even for unrelated messages. `waitingFor` is the discriminator: suspend and
      // approval waits also set status 'paused' but DO set `waitingFor` and resume by
      // signal; gating those would hang every approval and every suspended tool.
      const heldForHuman = freshRunState.status === 'paused' && !freshRunState.waitingFor;

      const model = opened.agent.model ?? this.defaultModel;
      if (!model) {
        throw new Error('Runtime requires agent.model or config.defaultModel');
      }

      const skillActivations: SkillActivation[] = [];

      runCtx = await createRunContext({
        policy: composePolicies(
          skillRestrictionPolicy(() => skillActivations),
          opened.agent.policy ?? this.config.policy ?? needsApprovalPolicy,
        ),
        skillActivations,
        skillMetaByName: openingSurface.skillMetaByName,
        session: opened.session,
        runState: freshRunState,
        runStore: opened.runStore,
        steps,
        toolExecutor,
        model,
        controlModel: opened.agent.controlModel ?? model,
        abortSignal: abortController.signal,
        emit,
        refinementPolicies: policies.refinementPolicies,
        validationPolicies: policies.validationPolicies,
        inputProcessors: policies.inputProcessors,
        outputProcessors: policies.outputProcessors,
        limits: policies.limits,
        autoRetrieve: knowledgeProvider
          ? buildAutoRetrieveProvider(knowledgeProvider, opened.agent)
          : undefined,
        memoryService: this.config.memoryService
          ? buildMemoryService(this.config.memoryService, opened.agent)
          : undefined,
        fs: openingSurface.resolvedWorkspace?.fs,
        getSkill: openingSurface.getSkill,
        signalDelivery: opts.signalDelivery,
      });

      // Session retrieval cache (G6): created once per run, persists across
      // in-session handoffs (runCtx survives the handoff branch). RAG-only —
      // a knowledge-less runtime leaves it undefined.
      runCtx.retrievalCache = knowledgeProvider?.createSessionCache();

      // Agent base layer (ADR 0001): composed into every node turn by the drivers.
      runCtx.baseInstructions = opened.agent.instructions;
      runCtx.globalTools = openingSurface.globalTools;
      runCtx.agentTools = opened.agent.tools ?? {};
      runCtx.outOfBandControl = resolveOutOfBandControl(opened.agent);
      runCtx.skillPrompt = openingSurface.skillPrompt;
      runCtx.workingMemoryPrompt = appendGoalsPrompt(
        openingSurface.workingMemoryPrompt,
        opened.session.workingMemory,
      );
      runCtx.workingMemoryTools = openingSurface.workingMemoryTools;

      await runCtx.resumePendingInterrupt(
        resolvePendingApprovalTool(opened.agent, runCtx.runState),
      );

      await runHookSafely('onStart', () => this.hooks?.onStart?.(runCtx));

      if (opts.wake) {
        emit({ channel: 'internal', type: 'wake', payload: { reason: opts.wake.reason } });
      }

      const driver = opts.driver ?? this.config.driver ?? new TextDriver();

      let activeAgent = opened.agent;
      let loopResult: HostLoopResult = { kind: 'turnComplete' };
      let handoffCount = 0;
      let terminalOutcome: ConversationOutcome | undefined;

      let overflowRetried = false;

      try {
        if (heldForHuman) {
          // Mirror the degraded-turn shape so TurnHandle consumers see a normal text +
          // `done` and do not hang: the hold message streams once, the turn is persisted,
          // and the existing `finally` emits `done` and runs closeRun. The agent never runs.
          const heldId = crypto.randomUUID();
          emit({ channel: 'client', type: 'text-start', payload: { id: heldId } });
          emit({ channel: 'client', type: 'text-delta', payload: { id: heldId, delta: HELD_FOR_HUMAN_MESSAGE } });
          emit({ channel: 'client', type: 'text-end', payload: { id: heldId } });
          runCtx.runState.messages = [
            ...runCtx.runState.messages,
            { role: 'assistant', content: HELD_FOR_HUMAN_MESSAGE },
          ];
          await runCtx.runStore.putRunState(runCtx.runState);
          // NOT a terminal outcome: the run stays `paused` (closeRun only flips to
          // `finished` when terminalOutcome is set). Setting it would both break the
          // hold — the next turn would no longer see `paused` — and trip a stale-version
          // outcome mark across multi-turn sessions.
          loopResult = { kind: 'ended', reason: 'held_for_human' };
        } else {
        turnLoop: for (;;) {
          try {
            loopResult = await hostLoop({
              agent: activeAgent,
              run: runCtx.runState,
              driver,
              ctx: runCtx,
              classify:
                this.config.hostClassify ??
                (this.config.hostSelect ? adaptHostSelect(this.config.hostSelect) : undefined),
            });
          } catch (error) {
            if (!overflowRetried && this.config.compaction && isContextOverflowError(error)) {
              overflowRetried = true;
              await this.recoverFromOverflow(runCtx, activeAgent, emit);
              continue turnLoop;
            }
            throw error;
          }

          if (loopResult.kind === 'handoff') {
            if (this.terminalHandoffTargets.has(loopResult.to)) {
              // This emit is load-bearing for TERMINAL targets specifically. A terminal
              // handoff breaks out of the loop here, before hostLoop's own emit and before
              // handoffHistory is appended — so this is the only handoff part a client ever
              // sees for an escalation. Removing it as "redundant" silently produced zero
              // handoff parts for every escalation; escalation.test.ts catches it.
              //
              // The self-edge seen live (handoff human->human, two spans on one turn) is a
              // real but SEPARATE defect on the non-terminal path — fix it there, not by
              // deleting this.
              if (!announcedHandoffs.has(loopResult.to)) {
                emit({
                  channel: 'internal',
                  type: 'handoff',
                  payload: { targetAgent: loopResult.to, reason: loopResult.reason },
                });
              }
              // Record the terminal handoff in handoffHistory. This branch used to `break`
              // before the non-terminal push below, so the array stayed empty and
              // isHandoffOscillating could never see repeated escalations. The oscillation
              // check only runs on the non-terminal branch and only counts consecutive
              // same-pair hops, so appending `agent -> human` here cannot trip a false
              // oscillation on a later legitimate handoff to a different target.
              opened.session.handoffHistory.push({
                from: runCtx.runState.activeAgentId,
                to: loopResult.to,
                reason: loopResult.reason ?? 'handoff',
                timestamp: new Date(),
              });
              runCtx.runState.status = 'paused';
              // Never hand off in silence. dispatchEscalation returns immediately when no
              // escalation handler is configured, so without this the turn ends with no
              // assistant text at all and the user cannot tell an escalation from a crash.
              if (!sawUserText) {
                const handoffId = crypto.randomUUID();
                emit({ channel: 'client', type: 'text-start', payload: { id: handoffId } });
                emit({
                  channel: 'client',
                  type: 'text-delta',
                  payload: { id: handoffId, delta: HANDOFF_TO_HUMAN_MESSAGE },
                });
                emit({ channel: 'client', type: 'text-end', payload: { id: handoffId } });
                runCtx.runState.messages = [
                  ...runCtx.runState.messages,
                  { role: 'assistant', content: HANDOFF_TO_HUMAN_MESSAGE },
                ];
              }
              await runCtx.runStore.putRunState(runCtx.runState);
              await this.dispatchEscalation(
                runCtx,
                activeAgent,
                { reason: loopResult.reason ?? 'handoff_to_human', category: loopResult.category },
                emit,
                { setLatch: false },
              );
              break;
            }

            handoffCount += 1;
            if (handoffCount > this.maxHandoffs) {
              throw new Error(`maxHandoffs exceeded (${this.maxHandoffs})`);
            }

            // Cross-turn ping-pong safeguard (handoffCount resets each turn, so it
            // can't catch A↔B oscillation spread across turns). This is a bound
            // ABOVE maxHandoffs: within-run runaway is caught by the maxHandoffs
            // check above; oscillation only fires for same-pair accumulation in the
            // persisted handoffHistory beyond that, so it never pre-empts maxHandoffs.
            if (
              isHandoffOscillating(
                opened.session.handoffHistory,
                runCtx.runState.activeAgentId,
                loopResult.to,
                this.maxHandoffs + 1,
              )
            ) {
              throw new Error(
                `Handoff oscillation detected between "${runCtx.runState.activeAgentId}" and "${loopResult.to}"`,
              );
            }

            const target = this.agentsById.get(loopResult.to);
            if (!target) {
              throw new Error(`Handoff target agent not found: ${loopResult.to}`);
            }

            opened.session.handoffHistory.push({
              from: runCtx.runState.activeAgentId,
              to: loopResult.to,
              reason: loopResult.reason ?? 'handoff',
              timestamp: new Date(),
            });

            const handoffTarget = loopResult.to;
            const routeFilter = activeAgent.routes?.find((r) => r.agent === handoffTarget)?.filter;
            const inputFilter = routeFilter ?? this.config.handoffInputFilter;
            if (inputFilter) {
              const filtered = await inputFilter({
                messages: runCtx.runState.messages,
                workingMemory: runCtx.session.workingMemory,
                sourceAgentId: runCtx.runState.activeAgentId,
                targetAgentId: handoffTarget,
                reason: loopResult.reason,
              });
              runCtx.runState.messages = filtered.messages as ModelMessage[];
              runCtx.session.workingMemory = filtered.workingMemory;
            }

            runCtx.runState.activeAgentId = loopResult.to;
            activeAgent = target;
            const targetSurface = await buildAgentToolSurface(target, opened.session, {
              configTools: this.config.tools,
              knowledgeProvider,
              defaultWorkingMemoryStore: this.config.defaultWorkingMemoryStore,
            });
            if (targetSurface.skillContentHash) {
              recorder?.recordSkillSnapshot(target.id, targetSurface.skillContentHash);
            }
            runCtx.autoRetrieve = knowledgeProvider
              ? buildAutoRetrieveProvider(knowledgeProvider, target)
              : undefined;
            runCtx.globalTools = targetSurface.globalTools;
            runCtx.agentTools = target.tools ?? {};
            runCtx.skillPrompt = targetSurface.skillPrompt;
            runCtx.workingMemoryPrompt = appendGoalsPrompt(
              targetSurface.workingMemoryPrompt,
              runCtx.session.workingMemory,
            );
            runCtx.workingMemoryTools = targetSurface.workingMemoryTools;
            runCtx.fs = targetSurface.resolvedWorkspace?.fs;
            runCtx.getSkill = targetSurface.getSkill ?? createNoSkillsGetSkill();
            // Swap alongside getSkill/policy/toolExecutor so a `load_skill` the target issues
            // after the handoff records the TARGET's `allowed-tools`. `skillActivations` is
            // intentionally shared (not reset here): a restriction activated before the handoff
            // survives into the target, which is the safer reading — a composed policy may only
            // grow more restrictive, and silently dropping a restriction across a handoff would
            // let a delegated worker shed a boundary it was meant to keep.
            runCtx.skillMetaByName = targetSurface.skillMetaByName;
            runCtx.memoryService = this.config.memoryService
              ? buildMemoryService(this.config.memoryService, target)
              : undefined;

            const targetPolicies = resolveAgentPolicies(target);
            const targetModel = target.model ?? this.defaultModel;
            if (!targetModel) {
              throw new Error('Runtime requires agent.model or config.defaultModel');
            }
            runCtx.baseInstructions =
              (this.config.silentHandoff ?? true)
                ? applyHandoffContinuation(target.instructions)
                : target.instructions;
            runCtx.model = targetModel;
            runCtx.controlModel = target.controlModel ?? targetModel;
            runCtx.outOfBandControl = resolveOutOfBandControl(target);
            runCtx.limits = targetPolicies.limits;
            runCtx.refinementPolicies = targetPolicies.refinementPolicies;
            runCtx.validationPolicies = targetPolicies.validationPolicies;
            runCtx.inputProcessors = targetPolicies.inputProcessors;
            runCtx.outputProcessors = targetPolicies.outputProcessors;
            runCtx.policy = composePolicies(
              skillRestrictionPolicy(() => runCtx.skillActivations ?? []),
              target.policy ?? this.config.policy ?? needsApprovalPolicy,
            );
            runCtx.toolExecutor = new CoreToolExecutor({
              tools: targetSurface.executorTools,
              enforcer: targetPolicies.enforcer,
              agentId: target.id,
              onInterim: (message) => {
                const id = crypto.randomUUID();
                emit({ channel: 'client', type: 'text-start', payload: { id } });
                emit({
                  channel: 'client',
                  type: 'text-delta',
                  payload: { id, delta: message },
                });
                emit({ channel: 'client', type: 'text-end', payload: { id } });
              },
              onChunk: (chunk, toolName, toolCallId) => {
                emit({
                  channel: 'internal',
                  type: 'tool-result',
                  payload: { toolName, result: chunk, toolCallId, preliminary: true },
                });
              },
            });

            await runCtx.runStore.putRunState(runCtx.runState);
            continue;
          }

          if (loopResult.kind === 'ended') {
            terminalOutcome = 'resolved';
            break;
          }

          if (loopResult.kind === 'paused') {
            if (runCtx.runState.waitingFor?.signalName === '__escalate') {
              // Flow escalate() parks on the durable signal — notify the human
              // side now; the latch keeps the post-resume terminal handoff from
              // notifying a second time.
              const meta = runCtx.runState.waitingFor.meta;
              await this.dispatchEscalation(
                runCtx,
                activeAgent,
                { reason: String(meta?.reason ?? 'flow_escalation') },
                emit,
                { setLatch: true },
              );
            }
            break;
          }

          break;
        }

        // Post-turn maintenance: text already streamed, so the summarizer call
        // is off the user's latency path; the NEXT turn starts compact.
        await this.applyCompaction(runCtx, activeAgent, emit, false);
        }
      } catch (error) {
        await runHookSafely('onError', () => this.hooks?.onError?.(runCtx, error as Error));
        if (isDegradableRuntimeError(error)) {
          const message = error instanceof Error ? error.message : String(error);
          emit({ channel: 'client', type: 'error', payload: { error: message } });
          const degradedId = crypto.randomUUID();
          emit({ channel: 'client', type: 'text-start', payload: { id: degradedId } });
          emit({
            channel: 'client',
            type: 'text-delta',
            payload: { id: degradedId, delta: SAFE_DEGRADED_MESSAGE },
          });
          emit({ channel: 'client', type: 'text-end', payload: { id: degradedId } });
          runCtx.runState.messages = [
            ...runCtx.runState.messages,
            { role: 'assistant', content: SAFE_DEGRADED_MESSAGE },
          ];
          await runCtx.runStore.putRunState(runCtx.runState);
          terminalOutcome = 'unresolved';
          loopResult = { kind: 'ended', reason: 'error_degraded' };
        } else {
          throw error;
        }
      } finally {
        this.activeTurnAborts.delete(sessionId);
        await closeRun({
          session: opened.session,
          runState: runCtx.runState,
          runStore: opened.runStore,
          sessionStore: this.sessionStore,
          auditBaseline,
          hooks: this.hooks,
          ctx: runCtx,
          terminalOutcome,
          outcomeReason: loopResult.kind === 'ended' ? loopResult.reason : undefined,
          memoryIngest: async () => {
            await runMemoryIngest(runCtx);
            if (this.config.trackGoals) {
              const controlModel =
                this.agentsById.get(runCtx.runState.activeAgentId)?.controlModel ??
                runCtx.controlModel;
              await updateGoalsFromTurn(runCtx, controlModel);
            }
          },
        });
        await runHookSafely('onEnd', () => this.hooks?.onEnd?.(runCtx));
        emit({
          channel: 'client',
          type: 'done',
          payload: {
            sessionId: opened.session.id,
            usage: computeTurnTraceUsage(usageBaseline, runCtx.runState.state),
          },
        });
      }

      return { text: collectAssistantText(runCtx.runState.messages), toolResults: [] };
    };

    const gated = async (): Promise<TurnResult> => {
      const release = await this.sessionMutex.acquire(sessionId);
      try {
        return await execute();
      } finally {
        release();
      }
    };

    return createTurnHandle({
      bus,
      abortController,
      run: gated,
    });
  }

  async runOnce(opts: RunOptions): Promise<AgentTrace> {
    const existing = opts.sessionId ? await this.sessionStore.get(opts.sessionId) : null;
    // Caller's explicit agentId wins, matching run() (`opts.agentId ?? defaultAgentId`).
    // Persisted state is the fallback, not an override — otherwise the two public
    // entry points disagree about which agent handles the same turn.
    const agentId =
      opts.agentId ?? existing?.activeAgentId ?? existing?.currentAgent ?? this.config.defaultAgentId;
    return recordRunOnce(this, { ...opts, agentId });
  }

  stream(opts: RunOptions): TurnHandle {
    return this.run(opts);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessionStore.get(sessionId);
  }

  async getTrace(traceId: string): Promise<AgentTrace | null> {
    await this.settleTraceWrites();
    return this.traceStore?.getTrace(traceId) ?? null;
  }

  async listTraces(sessionId: string): Promise<AgentTrace[]> {
    await this.settleTraceWrites();
    return this.traceStore?.listTraces(sessionId) ?? [];
  }

  getTraceStore(): TraceStore | undefined {
    return this.traceStore;
  }

  /** The agent used when neither the caller nor persisted state names one. */
  getDefaultAgentId(): string {
    return this.config.defaultAgentId;
  }

  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionStore.delete(sessionId);
  }

  abortSession(sessionId: string, reason?: string): void {
    this.activeTurnAborts.get(sessionId)?.abort(reason);
  }

  async replayAuditLog(
    sessionId: string,
    opts?: AuditListOptions,
  ): Promise<ConversationAuditEntry[]> {
    const session = await this.sessionStore.get(sessionId);
    const inline = session?.metadata?.audit ?? [];
    if (typeof this.sessionStore.listAuditEntries !== 'function') {
      return filterAuditEntries(inline, opts);
    }

    // The inline copy is the crash-safe fallback: a session save and a
    // dedicated audit append cannot be one transaction on every backend. Merge
    // both views so a failed/partial append never makes an event disappear,
    // while exact duplicates remain one logical audit record.
    const durable = await this.sessionStore.listAuditEntries(sessionId, opts);
    const byValue = new Map<string, ConversationAuditEntry>();
    for (const entry of [...durable, ...filterAuditEntries(inline, opts)]) {
      byValue.set(JSON.stringify(entry), entry);
    }
    return [...byValue.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  async markOutcome(
    sessionId: string,
    outcome: ConversationOutcome,
    opts?: { reason?: string; markedBy?: ConversationOutcomeMarkedBy },
  ): Promise<void> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await markSessionOutcome(this.sessionStore, session, outcome, {
      reason: opts?.reason,
      markedBy: opts?.markedBy ?? 'http',
    });
  }

  private shouldTrace(sessionId: string, input?: unknown): boolean {
    if (this.traceSinks.length === 0) return false;
    const sampling = this.config.tracing?.sampling;
    if (typeof sampling === 'function') {
      try { return sampling({ sessionId, input }); } catch { return false; }
    }
    if (sampling === undefined) return true;
    return sampling > 0 && (sampling >= 1 || Math.random() < sampling);
  }

  private writeSpan(original: AgentSpan): void {
    let span: AgentSpan | null = original;
    try {
      if (this.config.tracing?.redact) {
        span = this.config.tracing.redact(structuredClone(original));
      }
    } catch {
      return;
    }
    if (!span) return;
    for (const sink of this.traceSinks) {
      try {
        const result = sink.write(span);
        if (result instanceof Promise) {
          const pending = result.catch(() => {}).finally(() => this.pendingTraceWrites.delete(pending));
          this.pendingTraceWrites.add(pending);
        }
      } catch {
        // Traces are derived observability and never participate in run correctness.
      }
    }
  }

  private async settleTraceWrites(): Promise<void> {
    await Promise.allSettled([...this.pendingTraceWrites]);
    await Promise.allSettled(this.traceSinks.map((sink) => sink.flush?.()));
  }

  private flushTraceSinks(): void {
    for (const sink of this.traceSinks) {
      try {
        const result = sink.flush?.();
        if (result) {
          const pending = result.catch(() => {}).finally(() => this.pendingTraceWrites.delete(pending));
          this.pendingTraceWrites.add(pending);
        }
      } catch {
        // Export flushes are observational and never affect the run.
      }
    }
  }

  /**
   * Compact `runState.messages` when over the configured trigger (or always,
   * when `force`). Persists both the run state and the session message mirror.
   * Returns whether compaction applied.
   */
  private async applyCompaction(
    runCtx: RunContext,
    agent: AgentConfig,
    emit: (part: StreamPart) => void,
    force: boolean,
  ): Promise<boolean> {
    const config = this.config.compaction;
    if (!config) {
      return false;
    }
    const model = config.model ?? agent.controlModel ?? agent.model ?? this.defaultModel;
    if (!model) {
      return false;
    }

    const result = await compactMessages({
      messages: runCtx.runState.messages,
      model,
      config,
      force,
      lastPromptTokens: readLastPromptTokens(runCtx.runState.state),
    });

    if (!result.compacted) {
      if (force) {
        emit({
          channel: 'internal',
          type: 'compaction-skipped',
          payload: { reason: result.reason },
        });
      }
      return false;
    }

    runCtx.runState.messages = result.messages;
    runCtx.runState.updatedAt = Date.now();
    await runCtx.runStore.putRunState(runCtx.runState);

    await mutateSessionWithRetry(this.sessionStore, runCtx.session.id, (latest) => {
      latest.messages = [...result.messages];
    });
    runCtx.session.messages = [...result.messages];

    emit({
      channel: 'internal',
      type: 'context-compacted',
      payload: {
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        summarizedCount: result.summarizedCount,
      },
    });
    return true;
  }

  /**
   * Context-overflow recovery: strip the failed turn's partial assistant/tool
   * messages (the user's own message is preserved), force one compaction, and
   * let the caller retry the turn once.
   */
  private async recoverFromOverflow(
    runCtx: RunContext,
    agent: AgentConfig,
    emit: (part: StreamPart) => void,
  ): Promise<void> {
    runCtx.session.messages = runCtx.runState.messages;
    const recovery = await recoverFromContextOverflow(runCtx.session);
    runCtx.runState.messages = runCtx.session.messages;

    const compacted = await this.applyCompaction(runCtx, agent, emit, true);

    emit({
      channel: 'internal',
      type: 'context-overflow-recovered',
      payload: {
        strippedCount: recovery.strippedCount,
        compacted,
      },
    });
  }

  async getConversationLength(sessionId: string): Promise<number> {
    const runStore = new SessionRunStore(this.sessionStore, sessionId);
    const runState = await runStore.getRunState(sessionId);
    return runState?.messages.length ?? 0;
  }

  /**
   * Build the escalation request, invoke the configured handler, record the
   * outcome on session metadata, and emit the `escalation` stream part.
   * No-op without `config.escalation`. Handler errors become a `failed`
   * outcome — escalation must never take down the turn.
   */
  private async dispatchEscalation(
    runCtx: RunContext,
    agent: AgentConfig,
    info: { reason: string; category?: EscalationReason },
    emit: (part: StreamPart) => void,
    opts: { setLatch: boolean },
  ): Promise<void> {
    const config = this.config.escalation;
    if (!config) {
      return;
    }

    if (!opts.setLatch && runCtx.runState.state[ESCALATION_NOTIFIED_KEY]) {
      // The handler already fired when the flow parked on `__escalate`;
      // consume the latch instead of notifying twice.
      delete runCtx.runState.state[ESCALATION_NOTIFIED_KEY];
      await runCtx.runStore.putRunState(runCtx.runState);
      return;
    }

    const model =
      config.model ?? agent.controlModel ?? agent.model ?? this.defaultModel;
    const request = await buildEscalationRequest({
      session: runCtx.session,
      runState: runCtx.runState,
      reason: info.reason,
      category: info.category,
      config,
      model,
    });

    let outcome: EscalationOutcome;
    try {
      outcome = await config.handler(request);
    } catch (error) {
      outcome = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (opts.setLatch) {
      runCtx.runState.state[ESCALATION_NOTIFIED_KEY] = true;
    }
    await runCtx.runStore.putRunState(runCtx.runState);
    const latestSession = await mutateSessionWithRetry(
      this.sessionStore,
      runCtx.session.id,
      (latest) => {
        recordEscalationOutcome(latest, info.category ?? 'user-request', outcome);
      },
    );
    runCtx.session.metadata = latestSession.metadata;

    emit({
      channel: 'internal',
      type: 'escalation',
      payload: {
        reason: info.reason,
        category: info.category,
        outcome: outcome.status,
        summary: request.summary,
      },
    });
  }

  /**
   * Hand the conversation back to the bot after a human resolved an
   * escalation: appends a resolution note the model will see, clears any
   * parked flow/escalation state, and marks the run runnable again. The next
   * `run()` continues the conversation with full context.
   */
  async resumeFromEscalation(
    sessionId: string,
    opts?: { resolutionSummary?: string },
  ): Promise<void> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const runStore = new SessionRunStore(this.sessionStore, sessionId);
    const runState = await runStore.getRunState(sessionDerivedRunId(sessionId));
    if (!runState) {
      throw new Error(`No run state for session: ${sessionId}`);
    }

    // `run` lifetime: the assistant needs to know a human intervened for the rest of this
    // run, not just the next turn. As a system NOTE rather than a message it stops being a
    // prompt-injection surface (the resolution summary is human-authored free text) and
    // stops re-triggering the AI SDK warning on every post-resume turn.
    addSystemNote(
      runState,
      `[A human agent handled this conversation${
        opts?.resolutionSummary ? `. Resolution: ${opts.resolutionSummary}` : ''
      }. The assistant is now resuming.]`,
      { lifetime: 'run', tag: 'escalation-resume' },
    );
    runState.status = 'running';
    runState.waitingFor = undefined;
    runState.activeFlow = undefined;
    runState.activeNode = undefined;
    delete runState.state[ESCALATION_NOTIFIED_KEY];
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);

    await mutateSessionWithRetry(this.sessionStore, sessionId, (latest) => {
      latest.messages = [...runState.messages];
    });
  }
}

export function createRuntime(config: HarnessConfig): Runtime {
  return new Runtime(config);
}

function indexAgents(agents: AgentConfig[]): Map<string, AgentConfig> {
  const map = new Map<string, AgentConfig>();
  for (const agent of agents) {
    map.set(agent.id, agent);
    for (const child of agent.agents ?? []) {
      map.set(child.id, child);
    }
  }
  return map;
}

function collectAssistantText(messages: ModelMessage[]): string {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && typeof last.content === 'string') {
    return last.content;
  }
  return '';
}

function appendGoalsPrompt(
  workingMemoryPrompt: string | undefined,
  workingMemory: Record<string, unknown>,
): string | undefined {
  const goalsPrompt = projectGoalsPromptFromState(workingMemory);
  if (!goalsPrompt) {
    return workingMemoryPrompt;
  }
  return [workingMemoryPrompt, goalsPrompt].filter((part) => part && part.trim()).join('\n\n');
}

function resolvePendingApprovalTool(
  agent: AgentConfig,
  runState: import('./durable/types.js').RunState,
): AnyTool | undefined {
  const operation = runState.waitingFor?.operation;
  if (!operation || !runState.activeFlow || !runState.activeNode) return undefined;
  const flow = agent.flows?.find((candidate) => candidate.name === runState.activeFlow);
  const node = flow?.nodes.find((candidate) => candidate.id === runState.activeNode);
  if (node?.kind !== 'reply') return undefined;
  return resolveReplyNode(node, currentFlowState(runState)).localTools?.[operation.toolName];
}
