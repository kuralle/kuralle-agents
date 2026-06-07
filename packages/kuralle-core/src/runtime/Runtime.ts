import { randomUUID } from 'node:crypto';
import type { LanguageModel, ModelMessage } from 'ai';
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
import { createFsTool } from '../tools/fs/createFsTool.js';
import { hostLoop, type HostLoopResult } from './hostLoop.js';
import { isDegradableRuntimeError } from '../flow/degradableErrors.js';
import { SAFE_DEGRADED_MESSAGE } from '../flow/degrade.js';
import type { selectHostTarget } from './select.js';
import { openRun } from './openRun.js';
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
import { SessionMutex } from './SessionMutex.js';

export interface HarnessConfig {
  agents: AgentConfig[];
  defaultAgentId: string;
  sessionStore?: SessionStore;
  defaultModel?: LanguageModel;
  maxHandoffs?: number;
  terminalHandoffTargets?: string[];
  hooks?: Hooks;
  voiceMode?: boolean;
  hostSelect?: typeof selectHostTarget;
  tools?: Record<string, AnyTool>;
  knowledge?: KnowledgeProviderConfig;
  memoryService?: V1MemoryService;
}

export interface RunOptions {
  sessionId?: string;
  input?: string;
  selection?: ResolvedSelection;
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
        agentId: opts.agentId,
        seedMessages: opts.seedMessages,
        historyDelta: opts.historyDelta,
        signalDelivery: opts.signalDelivery,
        defaultAgentId: this.config.defaultAgentId,
        sessionStore: this.sessionStore,
      });

      const policies = resolveAgentPolicies(opened.agent);
      const agentTools: Record<string, AnyTool> = {
        ...(this.config.tools ?? {}),
        ...(opened.agent.tools ?? {}),
        // Global tools (ADR 0001) are model-visible in speaking turns via the
        // drivers; register their executors here too so a model call can actually
        // run them. Visibility stays gated (not exposed during collect extraction).
        ...(opened.agent.globalTools ?? {}),
      };

      if (opened.agent.workspace) {
        agentTools.workspace = createFsTool({ fs: opened.agent.workspace });
      }

      const workspaceTool = agentTools.workspace;

      const toolExecutor = new CoreToolExecutor({
        tools: agentTools,
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

      const knowledgeProvider = this.config.knowledge
        ? buildKnowledgeProvider(this.config.knowledge)
        : undefined;

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
        fs: opened.agent.workspace,
      });

      // Agent base layer (ADR 0001): composed into every node turn by the drivers.
      runCtx.baseInstructions = opened.agent.instructions;
      runCtx.globalTools = {
        ...(opened.agent.globalTools ?? {}),
        ...(workspaceTool ? { workspace: workspaceTool } : {}),
      };
      runCtx.outOfBandControl = opened.agent.experimental?.outOfBandControl ?? false;

      await this.hooks?.onStart?.(runCtx);

      const driver = opts.driver ?? new TextDriver();

      let activeAgent = opened.agent;
      let loopResult: HostLoopResult = { kind: 'turnComplete' };
      let handoffCount = 0;
      let terminalOutcome: ConversationOutcome | undefined;

      try {
        for (;;) {
          loopResult = await hostLoop({
            agent: activeAgent,
            run: runCtx.runState,
            driver,
            ctx: runCtx,
            select: this.config.hostSelect,
          });

          if (loopResult.kind === 'handoff') {
            if (this.terminalHandoffTargets.has(loopResult.to)) {
              emit({ type: 'handoff', targetAgent: loopResult.to, reason: loopResult.reason });
              runCtx.runState.status = 'paused';
              await runCtx.runStore.putRunState(runCtx.runState);
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
            runCtx.autoRetrieve = knowledgeProvider
              ? buildAutoRetrieveProvider(knowledgeProvider, target)
              : undefined;
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
            break;
          }

          break;
        }
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

  async getConversationLength(sessionId: string): Promise<number> {
    const runStore = new SessionRunStore(this.sessionStore, sessionId);
    const runState = await runStore.getRunState(sessionId);
    return runState?.messages.length ?? 0;
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
