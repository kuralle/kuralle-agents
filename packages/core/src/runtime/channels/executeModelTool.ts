import type { JSONValue } from 'ai';
import type { TurnControl } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { AnyTool } from '../../types/effectTool.js';
import { classifyControl } from '../../flow/classifyControl.js';
import { toolErrorResult } from '../../tools/controlResults.js';
import { idempotencyKey, logicalRunId } from '../durable/idempotency.js';
import { findStepByKey } from '../durable/replay.js';

export interface ModelToolCall {
  toolName: string;
  input: unknown;
  toolCallId: string;
}

export interface ModelToolCallOutcome {
  result: unknown;
  control?: TurnControl;
  failed: boolean;
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
    const message = error instanceof Error ? error.message : String(error);
    ctx.emit({ channel: 'client', type: 'error', payload: { error: message } });
    return { result: toolErrorResult(error), failed: true };
  }
}

function isParallelSafeTool(def: AnyTool | undefined): boolean {
  return def?.parallelSafe === true || def?.replay === false;
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
  const runOne = async (call: ModelToolCall, durableOpts?: { callsite?: string; index?: number }) => {
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

    // executeModelToolCall catches tool errors and resolves with failed: true; Promise.all relies
    // on that containment so one failed call cannot abandon sibling finalizeStep operations.
    await Promise.all(
      assignments.map(({ call, callsite, index }) =>
        runOne(call, { callsite, index }),
      ),
    );
  };

  for (let cursor = 0; cursor < toolCalls.length;) {
    const call = toolCalls[cursor]!;
    if (!isParallelSafeTool(localTools[call.toolName])) {
      await runOne(call);
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
