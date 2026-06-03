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
  retrieve(ctx: RunContext): Promise<string | undefined>;
}

export interface MemoryService {
  preload?(ctx: RunContext): Promise<string | undefined>;
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
