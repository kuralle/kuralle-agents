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
import type { HarnessStreamPart, TurnHandle } from '../types/stream.js';
import type { SignalDelivery } from './durable/types.js';
import type { ResolvedSelection } from '../types/selection.js';
import type { ConversationOutcome, ConversationOutcomeMarkedBy } from '../outcomes/types.js';
import { MemoryStore } from '../session/stores/MemoryStore.js';
import { TextDriver } from './channels/TextDriver.js';
import { createRunContext } from './ctx.js';
import { createEventBus, createTurnHandle } from '../events/TurnHandle.js';
import { CoreToolExecutor } from '../tools/effect/index.js';
import { buildAgentToolSurface } from './buildAgentToolSurface.js';
import { hostLoop, type HostLoopResult } from './hostLoop.js';
import { isDegradableRuntimeError } from '../flow/degradableErrors.js';
import { SAFE_DEGRADED_MESSAGE } from '../flow/degrade.js';
import type { classifyHostTarget, selectHostTarget } from './select.js';
import { adaptHostSelect } from './hostClassifyAdapter.js';
import { openRun, sessionDerivedRunId } from './openRun.js';
import { closeRun } from './closeRun.js';
import { SessionRunStore } from './durable/SessionRunStore.js';
import { loadRecordedSteps } from './durable/replay.js';
import { markSessionOutcome } from './outcomeMarking.js';
import { resolveAgentPolicies } from './policies/resolvePolicies.js';
import type { KnowledgeProviderConfig } from '../types/voice.js';
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
import { isContextOverflowError, recoverFromContextOverflow } from './contextOverflow.js';
import type { RunContext } from '../types/run-context.js';
import type { EscalationConfig, EscalationOutcome, EscalationReason } from '../escalation/types.js';
import {
  buildEscalationRequest,
  recordEscalationOutcome,
  ESCALATION_NOTIFIED_KEY,
} from '../escalation/escalation.js';
import type { WakeOptions } from '../scheduler/index.js';

export interface HarnessConfig {
  agents: AgentConfig[];
  defaultAgentId: string;
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
  abortSignal?: AbortSignal;
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

  constructor(private readonly config: HarnessConfig) {
    this.agentsById = indexAgents(config.agents);
    this.sessionStore = config.sessionStore ?? new MemoryStore();
    this.defaultModel = config.defaultModel;
    this.maxHandoffs = config.maxHandoffs ?? 5;
    this.terminalHandoffTargets = new Set(config.terminalHandoffTargets ?? ['human']);
    this.hooks = config.hooks;
  }

  run(opts: RunOptions): TurnHandle {
    if (opts.wake && opts.input !== undefined) {
      throw new Error('RunOptions.wake and RunOptions.input are mutually exclusive');
    }
    const sessionId = opts.sessionId || randomUUID();
    const bus = createEventBus();
    const abortController = new AbortController();
    this.activeTurnAborts.set(sessionId, abortController);
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const execute = async (): Promise<TurnResult> => {
      let runCtx!: import('../types/run-context.js').RunContext;
      const emit = (part: HarnessStreamPart) => {
        bus.emit(part);
        void this.hooks?.onStreamPart?.(runCtx, part);
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
        transcriptionModel: this.config.transcriptionModel,
        defaultAgentId: this.config.defaultAgentId,
        sessionStore: this.sessionStore,
      });

      const policies = resolveAgentPolicies(opened.agent);
      const knowledgeProvider = this.config.knowledge
        ? buildKnowledgeProvider(this.config.knowledge)
        : undefined;
      const openingSurface = await buildAgentToolSurface(opened.agent, opened.session, {
        configTools: this.config.tools,
        knowledgeProvider,
        defaultWorkingMemoryStore: this.config.defaultWorkingMemoryStore,
      });

      const toolExecutor = new CoreToolExecutor({
        tools: openingSurface.executorTools,
        enforcer: policies.enforcer,
        agentId: opened.agent.id,
        onInterim: (message) => {
          const id = crypto.randomUUID();
          emit({ type: 'text-start', id });
          emit({ type: 'text-delta', id, delta: message });
          emit({ type: 'text-end', id });
        },
      });
      const steps = await loadRecordedSteps(opened.runStore, opened.runState.runId);
      const freshRunState =
        (await opened.runStore.getRunState(opened.runState.runId)) ?? opened.runState;

      const model = opened.agent.model ?? this.defaultModel;
      if (!model) {
        throw new Error('Runtime requires agent.model or config.defaultModel');
      }

      runCtx = await createRunContext({
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
      });

      // Agent base layer (ADR 0001): composed into every node turn by the drivers.
      runCtx.baseInstructions = opened.agent.instructions;
      runCtx.globalTools = openingSurface.globalTools;
      runCtx.outOfBandControl = opened.agent.experimental?.outOfBandControl ?? false;
      runCtx.skillPrompt = openingSurface.skillPrompt;
      runCtx.workingMemoryPrompt = openingSurface.workingMemoryPrompt;
      runCtx.workingMemoryTools = openingSurface.workingMemoryTools;

      await this.hooks?.onStart?.(runCtx);

      if (opts.wake) {
        emit({ type: 'wake', reason: opts.wake.reason });
      }

      const driver = opts.driver ?? new TextDriver();

      let activeAgent = opened.agent;
      let loopResult: HostLoopResult = { kind: 'turnComplete' };
      let handoffCount = 0;
      let terminalOutcome: ConversationOutcome | undefined;

      let overflowRetried = false;

      try {
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
              emit({ type: 'handoff', targetAgent: loopResult.to, reason: loopResult.reason });
              runCtx.runState.status = 'paused';
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

            runCtx.runState.activeAgentId = loopResult.to;
            activeAgent = target;
            const targetSurface = await buildAgentToolSurface(target, opened.session, {
              configTools: this.config.tools,
              knowledgeProvider,
              defaultWorkingMemoryStore: this.config.defaultWorkingMemoryStore,
            });
            runCtx.autoRetrieve = knowledgeProvider
              ? buildAutoRetrieveProvider(knowledgeProvider, target)
              : undefined;
            runCtx.globalTools = targetSurface.globalTools;
            runCtx.skillPrompt = targetSurface.skillPrompt;
            runCtx.workingMemoryPrompt = targetSurface.workingMemoryPrompt;
            runCtx.workingMemoryTools = targetSurface.workingMemoryTools;
            runCtx.fs = targetSurface.resolvedWorkspace?.fs;
            runCtx.memoryService = this.config.memoryService
              ? buildMemoryService(this.config.memoryService, target)
              : undefined;
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
      } catch (error) {
        await this.hooks?.onError?.(runCtx, error as Error);
        if (isDegradableRuntimeError(error)) {
          const message = error instanceof Error ? error.message : String(error);
          emit({ type: 'error', error: message });
          const degradedId = crypto.randomUUID();
          emit({ type: 'text-start', id: degradedId });
          emit({ type: 'text-delta', id: degradedId, delta: SAFE_DEGRADED_MESSAGE });
          emit({ type: 'text-end', id: degradedId });
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
          hooks: this.hooks,
          ctx: runCtx,
          terminalOutcome,
          outcomeReason: loopResult.kind === 'ended' ? loopResult.reason : undefined,
          memoryIngest: async () => {
            await runMemoryIngest(runCtx);
          },
        });
        await this.hooks?.onEnd?.(runCtx);
        emit({ type: 'done', sessionId: opened.session.id });
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

  stream(opts: RunOptions): TurnHandle {
    return this.run(opts);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessionStore.get(sessionId);
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
    if (typeof this.sessionStore.listAuditEntries === 'function') {
      return this.sessionStore.listAuditEntries(sessionId, opts);
    }
    const session = await this.sessionStore.get(sessionId);
    return filterAuditEntries(session?.metadata?.audit ?? [], opts);
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

  /**
   * Compact `runState.messages` when over the configured trigger (or always,
   * when `force`). Persists both the run state and the session message mirror.
   * Returns whether compaction applied.
   */
  private async applyCompaction(
    runCtx: RunContext,
    agent: AgentConfig,
    emit: (part: HarnessStreamPart) => void,
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
    });

    if (!result.compacted) {
      if (force) {
        emit({ type: 'compaction-skipped', reason: result.reason });
      }
      return false;
    }

    runCtx.runState.messages = result.messages;
    runCtx.runState.updatedAt = Date.now();
    await runCtx.runStore.putRunState(runCtx.runState);

    const latest = await this.sessionStore.get(runCtx.session.id);
    if (latest) {
      latest.messages = [...result.messages];
      await this.sessionStore.save(latest);
    }
    runCtx.session.messages = [...result.messages];

    emit({
      type: 'context-compacted',
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      summarizedCount: result.summarizedCount,
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
    emit: (part: HarnessStreamPart) => void,
  ): Promise<void> {
    runCtx.session.messages = runCtx.runState.messages;
    const recovery = await recoverFromContextOverflow(runCtx.session);
    runCtx.runState.messages = runCtx.session.messages;

    const compacted = await this.applyCompaction(runCtx, agent, emit, true);

    emit({
      type: 'context-overflow-recovered',
      strippedCount: recovery.strippedCount,
      compacted,
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
    emit: (part: HarnessStreamPart) => void,
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

    recordEscalationOutcome(runCtx.session, info.category ?? 'user-request', outcome);
    if (opts.setLatch) {
      runCtx.runState.state[ESCALATION_NOTIFIED_KEY] = true;
    }
    await runCtx.runStore.putRunState(runCtx.runState);
    await this.sessionStore.save(runCtx.session);

    emit({
      type: 'escalation',
      reason: info.reason,
      category: info.category,
      outcome: outcome.status,
      summary: request.summary,
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

    const note: ModelMessage = {
      role: 'system',
      content: `[A human agent handled this conversation${
        opts?.resolutionSummary ? `. Resolution: ${opts.resolutionSummary}` : ''
      }. The assistant is now resuming.]`,
    };

    runState.messages = [...runState.messages, note];
    runState.status = 'running';
    runState.waitingFor = undefined;
    runState.activeFlow = undefined;
    runState.activeNode = undefined;
    delete runState.state[ESCALATION_NOTIFIED_KEY];
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);

    const latest = (await this.sessionStore.get(sessionId)) ?? session;
    latest.messages = [...runState.messages];
    await this.sessionStore.save(latest);
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
