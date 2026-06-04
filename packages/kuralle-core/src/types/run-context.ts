import type { LanguageModel, ModelMessage, TelemetrySettings } from 'ai';
import type { Session } from './session.js';
import type { InputProcessor, OutputProcessor } from './processors.js';
import type { RunState } from '../runtime/durable/types.js';
import type { RunStore } from '../runtime/durable/RunStore.js';
import type { HarnessStreamPart } from './stream.js';
import type { RefinementCapability } from '../capabilities/RefinementCapability.js';
import type { ValidationCapability } from '../capabilities/ValidationCapability.js';
import type { Limits } from './guardrails.js';
import type { AnyTool } from './effectTool.js';
import type { Instructions } from './agentConfig.js';
import type { AgentKnowledgeOverrides } from './voice.js';

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

export interface AutoRetrieveProvider {
  retrieve(ctx: RunContext, scope?: GatherScope): Promise<string | undefined>;
}

export interface MemoryService {
  preload?(ctx: RunContext, scope?: GatherScope): Promise<string | undefined>;
  ingest?(ctx: RunContext): Promise<void>;
}

export interface HookRunner {
  onStreamPart?(ctx: RunContext, part: HarnessStreamPart): void | Promise<void>;
}

export interface RunContext {
  session: Session;
  runState: RunState;
  runStore: RunStore;
  emit: (part: HarnessStreamPart) => void;
  toolExecutor: EffectToolExecutor;
  hookRunner: HookRunner;
  model: LanguageModel;
  /** Control-path model (routing, decide, extraction) at temperature 0. */
  controlModel: LanguageModel;
  /** When true, flow reply nodes use the out-of-band control evaluator (ADR 0003 H1). */
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
  telemetry?: TelemetrySettings;
  /**
   * Ephemeral, per-run-invocation flag: has the current turn's user input been
   * consumed yet by an input-node (collect/decide)? Input-nodes extract/decide
   * from the turn's fresh input; once it is consumed, later nodes in the same
   * turn pause (present prompt, await next turn) instead of acting on stale
   * context. Reset to false on every `createRunContext` (i.e. every turn).
   */
  turnInputConsumed?: boolean;
  /** Agent base layer (ADR 0001), set when entering a flow. `baseInstructions`
   *  is composed as a prefix into every node turn's system prompt (persona /
   *  safety / grounding floor); `globalTools` are safe tools made model-visible
   *  in every speaking turn. */
  baseInstructions?: Instructions;
  globalTools?: Record<string, AnyTool>;
  tool(name: string, args: unknown, options?: { toolCallId?: string; def?: AnyTool; toolCtx?: ToolContext }): Promise<unknown>;
  approve(req: { title: string; description?: string }): Promise<{ approved: boolean; by?: string }>;
  signal(name: string, opts?: { deadline?: number; meta?: Record<string, unknown> }): Promise<unknown>;
  now(): Promise<number>;
  uuid(): Promise<string>;
}

export type ActionContext = Pick<
  RunContext,
  'tool' | 'approve' | 'signal' | 'now' | 'uuid' | 'emit'
>;

export type ToolContext = Pick<
  RunContext,
  'session' | 'runState' | 'tool' | 'now' | 'uuid' | 'emit'
>;

export type { ModelMessage };
