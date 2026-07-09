import type { JSONValue } from 'ai';
import type { TurnControl } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { AnyTool } from '../../types/effectTool.js';
import { classifyControl } from '../../flow/classifyControl.js';
import { toolErrorResult } from '../../tools/controlResults.js';

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
): Promise<ModelToolCallOutcome> {
  try {
    const localTool = localTools?.[call.toolName];
    const toolResult = await ctx.tool(call.toolName, call.input, {
      toolCallId: call.toolCallId,
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
    ctx.emit({ type: 'error', error: message });
    return { result: toolErrorResult(error), failed: true };
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
