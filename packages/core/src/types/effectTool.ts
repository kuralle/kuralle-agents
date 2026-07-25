import type { StandardSchemaV1 } from './standard-schema.js';
import type { ToolContext } from './run-context.js';

export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  input?: StandardSchemaV1<TInput>;
  output?: StandardSchemaV1<TOutput>;
  needsApproval?: boolean;
  interruptible?: boolean;
  interim?: string;
  interimAfterMs?: number;
  timeoutMs?: number;
  /** When false, the durable journal always re-executes this tool instead of returning a cached step result — for observation/mutation tools (fs, shell) whose result must be fresh. Default true. */
  replay?: boolean;
  /** When true, the tool may run concurrently with other parallel-safe tools in the same model turn. */
  parallelSafe?: boolean;
  /** Override the auto-derived effect key (`idempotencyKey(logicalRunId, callsite, {name,args})`). Use when args are not a stable identity (e.g. a nonce). */
  idempotencyKey?: (args: TInput) => string;
  execute: (
    args: TInput,
    ctx?: ToolContext,
  ) => Promise<TOutput> | AsyncIterable<TOutput>;
  /** Recover from a thrown error by returning a result the model can act on. Not called for timeouts, aborts, schema violations, or control-flow signals. */
  onError?: (error: Error, args: TInput) => Promise<TOutput> | TOutput;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason: bivariant erased tool-collection storage; the AI-SDK/Mastra/VoltAgent pattern (per-tool inference stays at the defineTool authoring site)
export type AnyTool = Tool<any, any>;

export { defineTool } from '../tools/effect/defineTool.js';
