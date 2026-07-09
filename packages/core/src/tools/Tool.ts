import {
  tool as aiTool,
  zodSchema,
  type Tool as AiTool,
  type ToolSet as AiToolSet,
  type ToolExecutionOptions as AiToolExecutionOptions,
  type ToolExecuteFunction,
} from 'ai';
import type { ZodTypeAny, z } from 'zod';

export type Tool<TInput = unknown, TResult = unknown> = AiTool<TInput, TResult>;
export type ToolSet = AiToolSet;

export interface ToolExecutionContext {
  session?: unknown;
  sessionId?: string;
  agentId?: string;
  step?: number;
  turn?: number;
  toolName?: string;
  toolCallId?: string;
  idempotencyKey?: string;
  runtime?: unknown;  // Runtime instance for agent-to-agent consultation
  [key: string]: unknown;
}

export type ToolExecutionOptions = AiToolExecutionOptions;

export interface ToolDefinition<TInput = unknown, TResult = unknown> {
  description: string;
  inputSchema: ZodTypeAny;
  execute: ToolExecuteFunction<TInput, TResult>;
  /** If true (default), failure blocks turn success completion. */
  critical?: boolean;
  /** Action to take on execution error. */
  errorPolicy?: 'abort' | 'warn' | 'continue';
}

export interface ToolWithFiller<TInput = unknown, TResult = unknown> extends ToolDefinition<TInput, TResult> {
  /** @deprecated Use `interim` on effect tools (`defineTool`). */
  filler?: string;
  /** @deprecated Use `interimAfterMs` on effect tools (`defineTool`). */
  estimatedDurationMs?: number;
  interim?: string;
  interimAfterMs?: number;
}

type SchemaToolDefinition<TSchema extends ZodTypeAny, TResult = unknown> = {
  description: string;
  inputSchema: TSchema;
  execute: ToolExecuteFunction<z.infer<TSchema>, TResult>;
  critical?: boolean;
  errorPolicy?: 'abort' | 'warn' | 'continue';
};

type SchemaToolWithFiller<TSchema extends ZodTypeAny, TResult = unknown> =
  SchemaToolDefinition<TSchema, TResult> & {
    /** @deprecated Use `interim`. */
    filler?: string;
    /** @deprecated Use `interimAfterMs`. */
    estimatedDurationMs?: number;
    interim?: string;
    interimAfterMs?: number;
  };

export function createTool<TSchema extends ZodTypeAny, TResult = unknown>(
  definition: SchemaToolDefinition<TSchema, TResult>,
): Tool<z.infer<TSchema>, TResult> & ToolDefinition<z.infer<TSchema>, TResult> {
  const { description, inputSchema, execute } = definition;
  // AI SDK tool() overload resolution fails when INPUT/OUTPUT are deferred wrapper generics.
  // @ts-expect-error — config is structurally valid; failure is a TypeScript artifact only.
  const t = aiTool({ description, inputSchema: zodSchema(inputSchema), execute });
  return Object.assign(t, definition);
}

export function createToolWithFiller<TSchema extends ZodTypeAny, TResult = unknown>(
  definition: SchemaToolWithFiller<TSchema, TResult>,
): Tool<z.infer<TSchema>, TResult> & ToolWithFiller<z.infer<TSchema>, TResult> {
  const { description, inputSchema, execute } = definition;
  // @ts-expect-error — same deferred-generic limitation as createTool (see above).
  const t = aiTool({ description, inputSchema: zodSchema(inputSchema), execute });
  const extended = Object.assign(t, definition) as Tool<z.infer<TSchema>, TResult> &
    ToolWithFiller<z.infer<TSchema>, TResult>;
  const interim = definition.interim ?? definition.filler;
  const interimAfterMs = definition.interimAfterMs ?? definition.estimatedDurationMs;
  if (interim) {
    extended.interim = interim;
    if (definition.filler) extended.filler = definition.filler;
  }
  if (interimAfterMs != null) {
    extended.interimAfterMs = interimAfterMs;
    if (definition.estimatedDurationMs != null) {
      extended.estimatedDurationMs = definition.estimatedDurationMs;
    }
  }
  return extended;
}
