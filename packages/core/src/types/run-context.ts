import type { Policy } from '../runtime/policies/toolPolicy.js';
import type { LanguageModel, ModelMessage, TelemetryOptions } from 'ai';
import type { Session } from './session.js';
import type { InputProcessor, OutputProcessor } from './processors.js';
import type { RunState } from '../runtime/durable/types.js';
import type { RunStore } from '../runtime/durable/RunStore.js';
import type { StreamPart } from './stream.js';
import type { RefinementCapability } from '../capabilities/RefinementCapability.js';
import type { ValidationCapability } from '../capabilities/ValidationCapability.js';
import type { Limits } from './guardrails.js';
import type { AnyTool } from './effectTool.js';
import type { FileSystem } from './filesystem.js';
import type { Instructions } from './agentConfig.js';
import type { AgentKnowledgeOverrides, SourceRef, RetrievalCacheAdapter } from './knowledge.js';
import type { StandardSchemaV1 } from './standard-schema.js';
import type { SkillHandle } from '../skills/skillHandle.js';
import type { SkillActivation } from '../skills/skillActivation.js';
import type { LiveSkillCatalog } from '../skills/liveSkillCatalog.js';
import type { SkillLike } from './skills.js';
import type { FlowGateJudgeProvider } from '../flow/evaluateGates.js';

export interface ResumedToolOutcome {
  requestId: string;
  node?: string;
  toolName: string;
  args: unknown;
  toolCallId: string;
  result: unknown;
  failed: boolean;
}

export interface GatherScope {
  query?: string;
  knowledge?: AgentKnowledgeOverrides & { autoRetrieve?: boolean };
  memory?: { preload?: boolean; tokenBudget?: number };
}

export interface EffectToolExecutor {
  execute(args: {
    name: string;
    args: unknown;
    session: Session;
    toolCallId?: string;
    abortSignal?: AbortSignal;
    toolCtx?: ToolContext;
    def?: AnyTool;
  }): Promise<unknown>;
  /** Resolve a registered tool definition by name (used to read flags like `needsApproval`). */
  getTool?(name: string): AnyTool | undefined;
}

export interface AutoRetrieveResult {
  block?: string;
  citations?: SourceRef[];
}

export interface AutoRetrieveProvider {
  retrieve(ctx: RunContext, scope?: GatherScope): Promise<AutoRetrieveResult | string | undefined>;
}

export interface MemoryService {
  preload?(ctx: RunContext, scope?: GatherScope): Promise<string | undefined>;
}

export interface RunContext {
  session: Session;
  runState: RunState;
  runStore: RunStore;
  emit: (part: StreamPart) => void;
  toolExecutor: EffectToolExecutor;
  /** Decides allow / ask / deny per tool call. Reassigned on handoff. */
  policy: Policy;
  model: LanguageModel;
  /** Control-path model (routing, decide, extraction) at temperature 0. */
  controlModel: LanguageModel;
  /** When true, flow reply nodes use the out-of-band control evaluator. */
  outOfBandControl: boolean;
  refinementPolicies: RefinementCapability[];
  validationPolicies: ValidationCapability[];
  inputProcessors: InputProcessor[];
  outputProcessors: OutputProcessor[];
  limits?: Limits;
  autoRetrieve?: AutoRetrieveProvider;
  memoryService?: MemoryService;
  bargeIn?: AbortSignal;
  abortSignal?: AbortSignal;
  telemetry?: TelemetryOptions;
  /**
   * Ephemeral, per-run-invocation flag: has the current turn's user input been
   * consumed yet by an input-node (collect/decide)? Input-nodes extract/decide
   * from the turn's fresh input; once it is consumed, later nodes in the same
   * turn pause (present prompt, await next turn) instead of acting on stale
   * context. Reset to false on every `createRunContext` (i.e. every turn).
   */
  turnInputConsumed?: boolean;
  /** Citations from the latest gather-phase retrieval on this turn. */
  lastRetrievalCitations?: SourceRef[];
  /**
   * Session retrieval cache (G6): created once per run by the KnowledgeProvider,
   * persists across in-session agent handoffs (this RunContext survives the
   * handoff branch). Keyed by query embedding; RAG-only, undefined without a
   * configured knowledge provider + embedder.
   */
  retrievalCache?: RetrievalCacheAdapter;
  /** Agent base layer, set when entering a flow. `baseInstructions`
   *  is composed as a prefix into every node turn's system prompt (persona /
   *  safety / grounding floor); `globalTools` are safe tools made model-visible
   *  in every speaking turn. */
  baseInstructions?: Instructions;
  globalTools?: Record<string, AnyTool>;
  /** Agent-scoped tools (`agent.tools`) for `toolScope: 'open'` resolution in flow nodes. */
  agentTools?: Record<string, AnyTool>;
  /** Level-1 skill metadata injected by `SkillsCapability` when `AgentConfig.skills` is set. */
  skillPrompt?: string;
  /** Frozen persistent memory blocks loaded at session start (`AgentMemory.workingMemory`). */
  workingMemoryPrompt?: string;
  /** Model-visible tools from working memory wiring (not in globalTools — mutating but scoped). */
  workingMemoryTools?: Record<string, AnyTool>;
  /** Agent workspace filesystem (same instance as `AgentConfig.workspace`). */
  fs?: FileSystem;
  /** Read-only access to bundled skill resources for tool/action code. */
  getSkill(name: string): SkillHandle;
  /** Turn-scoped skills activated by successful `load_skill` with `allowed-tools`. */
  skillActivations?: SkillActivation[];
  /** @internal Skill metadata indexed by name; swapped on handoff so the target's
   *  `load_skill` records the right `allowed-tools` activation (see `ctx.tool`). */
  skillMetaByName?: ReadonlyMap<string, import('../types/skills.js').SkillMeta>;
  /** The live skill catalog `load_skill` resolves against for this run. The frozen roster
   *  in `skillPrompt` is the baseline; this mutates freely and changes are announced in the
   *  transcript (never by rewriting `skillPrompt`). Undefined when the agent has no skills. */
  skillCatalog?: LiveSkillCatalog;
  /** Add a skill to the live catalog for the current session. Announces the change once in
   *  the transcript and leaves `skillPrompt` byte-identical. No-op when the agent has no skills. */
  addSkill(skill: SkillLike): Promise<void>;
  /** Withdraw a skill from the live catalog. Announces the withdrawal once. No-op when the
   *  agent has no skills or the skill was never available. */
  removeSkill(name: string): Promise<void>;
  tool(
    name: string,
    args: unknown,
    options?: {
      toolCallId?: string;
      def?: AnyTool;
      toolCtx?: ToolContext;
      /** Pre-reserved callsite ordinal for parallel-safe tool batches (G9). */
      callsite?: string;
      /** Pre-reserved journal index for parallel-safe tool batches (G9). */
      index?: number;
    },
  ): Promise<unknown>;
  approve(req: { title: string; description?: string }): Promise<{ approved: boolean; by?: string }>;
  signal<T>(
    name: string,
    opts: {
      schema: StandardSchemaV1<unknown, T>;
      responseSchema?: Record<string, unknown>;
      title?: string;
      description?: string;
      deadline?: number;
      meta?: Record<string, unknown>;
    },
  ): Promise<T>;
  now(): Promise<number>;
  uuid(): Promise<string>;
  /** Rebase durable effect callsites to 0. The runtime calls this at flow entry so
   *  a flow's durable callsites are anchored to the flow — identical on fresh entry
   *  (after an answering turn) and on resume (where that turn does not re-run). */
  resetCallsites(): void;
  /** Reserve N contiguous effect callsite ordinals for parallel-safe tool batches (G9). */
  reserveCallsites(count: number): string[];
  /** @internal Persist model messages needed to continue after a tool approval pause. */
  attachInterruptContinuation(messages: ModelMessage[]): Promise<void>;
  /** @internal Validate a pending approval and execute its frozen operation. */
  resumePendingInterrupt(def?: AnyTool): Promise<ResumedToolOutcome | undefined>;
  /** @internal Consume a directly resumed model-tool outcome at its source flow node. */
  takeResumedToolOutcome(nodeId: string): ResumedToolOutcome | undefined;
  /**
   * Structured judge for flow `gates` of kind `judge`. Absent at evaluation
   * time is an execution error (always blocking).
   */
  flowGateJudge?: FlowGateJudgeProvider | LanguageModel;
}

export type ActionContext = Pick<
  RunContext,
  'tool' | 'approve' | 'signal' | 'now' | 'uuid' | 'emit' | 'fs' | 'getSkill'
>;

export type ToolContext = Pick<
  RunContext,
  'session' | 'runState' | 'tool' | 'now' | 'uuid' | 'emit' | 'fs' | 'abortSignal' | 'getSkill'
>;

export type { ModelMessage };
