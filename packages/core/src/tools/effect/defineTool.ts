import { tool as aiTool, type Tool as AiTool, type ToolSet } from 'ai';
import type { z } from 'zod';
import type { Tool, AnyTool } from '../../types/effectTool.js';
import type { ToolContext } from '../../types/run-context.js';
import type { StandardSchemaV1 } from '../../types/standard-schema.js';

type InferToolInput<S> = S extends z.ZodTypeAny
  ? z.infer<S>
  : S extends StandardSchemaV1<infer I>
    ? I
    : unknown;

export function defineTool<
  S extends z.ZodTypeAny | StandardSchemaV1 | undefined = undefined,
  R = unknown,
>(config: {
  name?: string;
  description: string;
  input?: S;
  output?: Tool<InferToolInput<S>, R>['output'];
  needsApproval?: boolean;
  interruptible?: boolean;
  interim?: string;
  interimAfterMs?: number;
  /** @deprecated Use `interim`. */
  filler?: string;
  /** @deprecated Use `interimAfterMs`. */
  estimatedDurationMs?: number;
  timeoutMs?: number;
  replay?: boolean;
  /**
   * Safe to run concurrently with sibling calls in the same model-emitted batch. A function
   * form receives the RAW (unvalidated) model args — classification happens before schema
   * validation — and must not throw; a throw or a non-boolean return is treated as NOT
   * parallel-safe. Never model-controlled: the model cannot assert this, only the tool author.
   */
  parallelSafe?: boolean | ((args: InferToolInput<S>) => boolean);
  idempotencyKey?: (args: InferToolInput<S>) => string;
  execute: (
    args: InferToolInput<S>,
    ctx?: ToolContext,
  ) => Promise<R> | AsyncIterable<R>;
  /**
   * Turns a thrown error into a result the model can act on, instead of a generic failure.
   * Return a value to recover; rethrow (or omit this) to let the error propagate.
   *
   * Runs only for genuine failures — never for a timeout, an abort, an input/output schema
   * violation, or a control-flow signal, all of which must stay distinguishable from a
   * result the tool chose to return.
   */
  onError?: (error: Error, args: InferToolInput<S>) => Promise<R> | R;
}): Tool<InferToolInput<S>, R> {
  return {
    name: config.name ?? inferToolName(config.description),
    description: config.description,
    input: config.input,
    output: config.output,
    needsApproval: config.needsApproval,
    interruptible: config.interruptible,
    interim: config.interim ?? config.filler,
    interimAfterMs: config.interimAfterMs ?? config.estimatedDurationMs,
    timeoutMs: config.timeoutMs,
    replay: config.replay,
    parallelSafe: config.parallelSafe,
    idempotencyKey: config.idempotencyKey,
    execute: config.execute,
    onError: config.onError,
  } as Tool<InferToolInput<S>, R>;
}

export function toolToAiSdk<TInput = unknown, TOutput = unknown>(
  def: Tool<TInput, TOutput>,
): AiTool<TInput, TOutput> {
  const spec: {
    description: string;
    inputSchema?: Tool<TInput, TOutput>['input'];
    execute?: never;
  } = {
    description: def.description,
  };
  if (def.input) {
    spec.inputSchema = def.input;
  }
  return aiTool(spec as Parameters<typeof aiTool>[0]) as AiTool<TInput, TOutput>;
}

// `buildToolSet` produces a model-facing ToolSet whose entries are schema-only
// (`toolToAiSdk` strips `execute`). Stash the raw effect tools (with executors),
// keyed by the returned ToolSet, so a flow node can recover its executors for
// in-flow execution without separately registering them on `agent.tools`.
// (see `resolveReplyNode`). The WeakMap is GC-friendly and invisible to callers.
const rawToolsBySet = new WeakMap<ToolSet, Record<string, AnyTool>>();
const RAW_TOOLS = Symbol.for('@kuralle-agents/core.raw-tools-by-set');

type ToolSetWithRawTools = ToolSet & {
  [RAW_TOOLS]?: Record<string, AnyTool>;
};

export function buildToolSet(tools: Record<string, AnyTool>): ToolSet {
  const set: ToolSet = {};
  const byName: Record<string, AnyTool> = {};
  for (const [key, def] of Object.entries(tools)) {
    const name = def.name || key;
    set[name] = toolToAiSdk(def);
    byName[name] = def;
  }
  rawToolsBySet.set(set, byName);
  // A CLI or dev loader can legitimately have two Core module instances in one
  // process (for example, a built runtime loading a source-tree AgentConfig).
  // WeakMap identity is local to one module instance, so attach the same data
  // through a process-global symbol as well. Non-enumerable keeps it out of the
  // AI SDK tool schema and JSON serialization.
  Object.defineProperty(set, RAW_TOOLS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: byName,
  });
  return set;
}

/** Recover the raw effect tools (with executors) from a `buildToolSet` output. */
export function rawToolsFromSet(set: ToolSet): Record<string, AnyTool> | undefined {
  return rawToolsBySet.get(set) ?? (set as ToolSetWithRawTools)[RAW_TOOLS];
}

function inferToolName(description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
  return slug || 'tool';
}
