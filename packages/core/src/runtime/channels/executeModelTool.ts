import type { JSONValue } from 'ai';
import type { TurnControl } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { AnyTool } from '../../types/effectTool.js';
import { classifyControl } from '../../flow/classifyControl.js';
import { toolDeniedResult, toolErrorResult } from '../../tools/controlResults.js';
import { idempotencyKey, logicalRunId } from '../durable/idempotency.js';
import { findStepByKey } from '../durable/replay.js';
import { isApprovalDenial, isControlFlowSignal, isRecoverableToolError } from '../controlFlowSignal.js';

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
      return { result: toolDeniedResult(error.toolName, error.by), failed: true };
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

function isParallelSafeTool(def: AnyTool | undefined): boolean {
  return def?.parallelSafe === true || def?.replay === false;
}

/**
 * Runs `task` over every item, at most `limit` at a time, preserving result order.
 *
 * Unbounded `Promise.all` over a model-emitted batch lets the model decide how many
 * sockets, subprocesses, or rate-limited API calls open at once. `limit` is a ceiling on
 * that; omitting it keeps the previous unbounded behaviour.
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
      const def = localTools[call.toolName];
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
      const def = localTools[call.toolName];
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
      ctx.limits?.maxToolConcurrency,
    );
    const suspended = signals.find((signal) => signal !== undefined);
    if (suspended !== undefined) throw suspended;
  };

  for (let cursor = 0; cursor < toolCalls.length;) {
    const call = toolCalls[cursor]!;
    if (!isParallelSafeTool(localTools[call.toolName])) {
      const signal = await runOne(call);
      if (signal !== undefined) throw signal;
      cursor += 1;
      continue;
    }

    const parallel: ModelToolCall[] = [];
    while (
      cursor < toolCalls.length &&
      isParallelSafeTool(localTools[toolCalls[cursor]!.toolName])
    ) {
      parallel.push(toolCalls[cursor]!);
      cursor += 1;
    }
    await runParallel(parallel);
  }
}

export function toolResultMessage(
  call: ModelToolCall,
  result: unknown,
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
        output: { type: 'json', value: result as JSONValue },
      },
    ],
  };
}
