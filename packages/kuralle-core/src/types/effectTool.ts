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
  execute: (
    args: TInput,
    ctx?: ToolContext,
  ) => Promise<TOutput> | AsyncIterable<TOutput>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason: bivariant erased tool-collection storage; the AI-SDK/Mastra/VoltAgent pattern (per-tool inference stays at the defineTool authoring site)
export type AnyTool = Tool<any, any>;

export { defineTool } from '../tools/effect/defineTool.js';
