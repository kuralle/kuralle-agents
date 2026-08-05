import type { JSONValue } from 'ai';
import type { TurnControl } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { AnyTool } from '../../types/effectTool.js';
import { classifyControl } from '../../flow/classifyControl.js';
import { toolDeniedResult, toolErrorResult } from '../../tools/controlResults.js';
import { idempotencyKey, logicalRunId } from '../durable/idempotency.js';
import { findStepByKey } from '../durable/replay.js';
import { isApprovalDenial, isControlFlowSignal, isRecoverableToolError } from '../controlFlowSignal.js';
import { DEFAULT_MAX_TOOL_RESULT_TOKENS, truncateForTranscript } from './truncateToolResult.js';

export interface ModelToolCall {
  toolName: string;
  input: unknown;
  toolCallId: string;
}

export interface ModelToolCallOutcome {
  result: unknown;
  control?: TurnControl;
  failed: boolean;
  /**
   * Set when the call unwound with a control-flow signal rather than a failure. Held as a
   * value so a parallel batch can still finalize its siblings; the dispatcher rethrows it
   * once the batch has settled. Never surfaced to the model.
   */
  signal?: unknown;
}

export async function executeModelToolCall(
  ctx: RunContext,
  call: ModelToolCall,
  localTools?: Record<string, AnyTool>,
  durableOpts?: { callsite?: string; index?: number },
): Promise<ModelToolCallOutcome> {
  try {
    const localTool = localTools?.[call.toolName];
    const toolResult = await ctx.tool(call.toolName, call.input, {
      toolCallId: call.toolCallId,
      callsite: durableOpts?.callsite,
      index: durableOpts?.index,
      ...(localTool && {
        def: localTool,
        toolCtx: {
          session: ctx.session,
          runState: ctx.runState,
          tool: ctx.tool.bind(ctx),
          now: ctx.now.bind(ctx),
          uuid: ctx.uuid.bind(ctx),
          emit: ctx.emit.bind(ctx),
          fs: ctx.fs,
          getSkill: ctx.getSkill.bind(ctx),
          abortSignal: ctx.abortSignal,
        },
      }),
    });
    return { result: toolResult, control: classifyControl(toolResult), failed: false };
  } catch (error) {
    if (isControlFlowSignal(error)) {
      // A suspend. Not a failure, so no client-facing error and no tool result: returning it
      // as a value keeps this function's never-rejects contract (which `Promise.all` below
      // depends on) while letting the dispatcher rethrow it once the batch has settled.
      return { result: undefined, failed: true, signal: error };
    }
    if (isApprovalDenial(error)) {
      // A human declined. The model asked for this call, so the model is told — otherwise
      // the turn dies and the user never hears why. No client error part: nothing broke.
      return { result: toolDeniedResult(error.toolName, error.by, error.reason), failed: true };
    }
    if (isRecoverableToolError(error)) {
      // The model can correct this (bad referent, missing precondition): return the message
      // as a tool result so it can retry. Not a malfunction, so no client error part —
      // same posture as an approval denial.
      return { result: toolErrorResult(error), failed: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.emit({ channel: 'client', type: 'error', payload: { error: message } });
    return { result: toolErrorResult(error), failed: true };
  }
}

/**
 * Ceiling on parallel-safe tools running at once within one model-emitted batch.
 *
 * The model's batch size must never be the concurrency policy: an unbounded
 * `Promise.all` lets a twelve-call response open twelve sockets, twelve
 * subprocesses, or twelve rate-limited vendor calls at once.
 *
 * Eight is not an arbitrary round number. Above eight-way in-process tool
 * concurrency the session store's optimistic-concurrency check starts rejecting
 * concurrent writes and surfacing `Stale write for session …` as client-visible
 * error parts; at eight and below it does not. Measured in
 * `packages/core/examples/latency-bench` — twelve unbounded calls emit four such
 * errors, the same twelve at a limit of eight emit none.
 */
export const DEFAULT_MAX_TOOL_CONCURRENCY = 8;

/**
 * Classifies a tool call as safe to run in a parallel batch. Evaluated on the RAW model args,
 * before schema validation, so a function `parallelSafe` must be total: any throw or
 * non-boolean return fails closed to serial rather than crashing the dispatcher.
 */
function isParallelSafeTool(def: AnyTool | undefined, args: unknown): boolean {
  if (!def) return false;
  const p = def.parallelSafe;
  if (p === true) return true;
  if (typeof p !== 'function') return false;
  try {
    const verdict = (p as (args: unknown) => unknown)(args);
    // Classification is synchronous — a batch is assembled before anything runs —
    // so a promise cannot be awaited here and fails closed to serial. Attach a
    // catch first: returning without one leaves a rejected promise unhandled,
    // which Bun and Node surface as a process-level warning or crash. TypeScript
    // already rejects an async predicate, so this only catches a type-system bypass.
    if (typeof (verdict as { then?: unknown } | null)?.then === 'function') {
      void (verdict as Promise<unknown>).catch(() => {});
      return false;
    }
    return verdict === true;
  } catch {
    return false;
  }
}

function resolveToolDef(
  name: string,
  localTools: Record<string, AnyTool>,
  ctx: RunContext,
): AnyTool | undefined {
  return localTools[name] ?? ctx.toolExecutor.getTool?.(name);
}

/**
 * Runs `task` over every item, at most `limit` at a time, preserving result order.
 *
 * Unbounded `Promise.all` over a model-emitted batch lets the model decide how many
 * sockets, subprocesses, or rate-limited API calls open at once. `limit` is a ceiling on
 * that, and callers always pass one — see `DEFAULT_MAX_TOOL_CONCURRENCY`.
 *
 * `task` is expected not to reject (see the caller's contract). If one does, the rejection
 * propagates and in-flight siblings still run to completion — they are not cancelled, so
 * their journal writes complete rather than being abandoned half-done.
 */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  task: (item: T) => Promise<R>,
  limit?: number,
): Promise<R[]> {
  if (limit === undefined || limit <= 0 || limit >= items.length) {
    return Promise.all(items.map((item) => task(item)));
  }

  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

export async function dispatchModelToolCalls(
  ctx: RunContext,
  toolCalls: ModelToolCall[],
  localTools: Record<string, AnyTool>,
  onEach: (args: {
    call: ModelToolCall;
    outcome: ModelToolCallOutcome;
  }) => void,
): Promise<void> {
  /** Resolves to a control-flow signal when the call suspended, otherwise `undefined`. */
  const runOne = async (
    call: ModelToolCall,
    durableOpts?: { callsite?: string; index?: number },
  ): Promise<unknown> => {
    ctx.emit({
      channel: 'internal',
      type: 'tool-call',
      payload: {
        toolName: call.toolName,
        args: call.input,
        toolCallId: call.toolCallId,
      },
    });
    const outcome = await executeModelToolCall(ctx, call, localTools, durableOpts);
    if (outcome.signal !== undefined) {
      // Suspended: no result exists, so nothing may reach the model or the transcript.
      return outcome.signal;
    }
    onEach({ call, outcome });
    ctx.emit({
      channel: 'internal',
      type: 'tool-result',
      payload: {
        toolName: call.toolName,
        result: outcome.result,
        toolCallId: call.toolCallId,
      },
    });
    return undefined;
  };

  const runParallel = async (parallel: ModelToolCall[]) => {
    const callsites = ctx.reserveCallsites(parallel.length);
    const steps = await ctx.runStore.getSteps(ctx.runState.runId);
    const logicalId = logicalRunId(ctx.runState.runId, ctx.runState.runEpoch);
    const unresolved = parallel.filter((call, i) => {
      const def = resolveToolDef(call.toolName, localTools, ctx);
      const key =
        def?.idempotencyKey != null
          ? def.idempotencyKey(call.input)
          : idempotencyKey(logicalId, callsites[i]!, { name: call.toolName, args: call.input });
      const hit = findStepByKey(steps, key);
      return !hit || hit.status === 'running';
    });

    let indices: number[] | undefined;
    if (unresolved.length > 0 && ctx.runStore.reserveSteps) {
      indices = await ctx.runStore.reserveSteps(ctx.runState.runId, unresolved.length);
    }

    let unresolvedCursor = 0;
    const assignments = parallel.map((call, i) => {
      const def = resolveToolDef(call.toolName, localTools, ctx);
      const key =
        def?.idempotencyKey != null
          ? def.idempotencyKey(call.input)
          : idempotencyKey(logicalId, callsites[i]!, { name: call.toolName, args: call.input });
      const hit = findStepByKey(steps, key);
      const needsIndex = !hit || hit.status === 'running';
      const index = needsIndex ? indices?.[unresolvedCursor++] : hit?.index;
      return { call, callsite: callsites[i]!, index };
    });

    // executeModelToolCall never rejects — tool errors resolve with failed: true and control-flow
    // signals resolve as outcome.signal — so no sibling can be abandoned mid-flight with its
    // finalizeStep unawaited. A suspend is rethrown only after every sibling has settled: you
    // cannot cancel an in-flight promise, so failing fast here would let the work happen anyway
    // while the journal recorded it as still running.
    const signals = await runWithConcurrency(
      assignments,
      ({ call, callsite, index }) => runOne(call, { callsite, index }),
      ctx.limits?.maxToolConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY,
    );
    const suspended = signals.find((signal) => signal !== undefined);
    if (suspended !== undefined) throw suspended;
  };

  for (let cursor = 0; cursor < toolCalls.length;) {
    const call = toolCalls[cursor]!;
    if (!isParallelSafeTool(resolveToolDef(call.toolName, localTools, ctx), call.input)) {
      const signal = await runOne(call);
      if (signal !== undefined) throw signal;
      cursor += 1;
      continue;
    }

    const parallel: ModelToolCall[] = [];
    while (
      cursor < toolCalls.length &&
      isParallelSafeTool(
        resolveToolDef(toolCalls[cursor]!.toolName, localTools, ctx),
        toolCalls[cursor]!.input,
      )
    ) {
      parallel.push(toolCalls[cursor]!);
      cursor += 1;
    }
    await runParallel(parallel);
  }
}

/**
 * Builds the transcript-facing tool-result message. This is the transcript boundary: the
 * result is bounded to `maxTokens` here so the model never re-reads an unbounded payload on
 * every subsequent call. `ctx.tool()` and the durable journal are unaffected — they receive
 * the full value before this function is ever called.
 */
export function toolResultMessage(
  call: ModelToolCall,
  result: unknown,
  maxTokens: number = DEFAULT_MAX_TOOL_RESULT_TOKENS,
): {
  role: 'tool';
  content: [
    {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: { type: 'json'; value: JSONValue };
    },
  ];
} {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: 'json', value: truncateForTranscript(result, maxTokens) as JSONValue },
      },
    ],
  };
}
