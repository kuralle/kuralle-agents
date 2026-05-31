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
  execute: (
    args: InferToolInput<S>,
    ctx?: ToolContext,
  ) => Promise<R> | AsyncIterable<R>;
}): Tool<InferToolInput<S>, R> {
  return {
    name: config.name ?? inferToolName(config.description),
    description: config.description,
    input: config.input,
    output: config.output,
    needsApproval: config.needsApproval,
    interruptible: config.interruptible,
    interim: config.interim,
    interimAfterMs: config.interimAfterMs,
    execute: config.execute,
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
// in-flow execution without separately registering them on `agent.effectTools`
// (see `resolveReplyNode`). The WeakMap is GC-friendly and invisible to callers.
const rawToolsBySet = new WeakMap<ToolSet, Record<string, AnyTool>>();

export function buildToolSet(tools: Record<string, AnyTool>): ToolSet {
  const set: ToolSet = {};
  const byName: Record<string, AnyTool> = {};
  for (const [key, def] of Object.entries(tools)) {
    const name = def.name || key;
    set[name] = toolToAiSdk(def);
    byName[name] = def;
  }
  rawToolsBySet.set(set, byName);
  return set;
}

/** Recover the raw effect tools (with executors) from a `buildToolSet` output. */
export function rawToolsFromSet(set: ToolSet): Record<string, AnyTool> | undefined {
  return rawToolsBySet.get(set);
}

function inferToolName(description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
  return slug || 'tool';
}
