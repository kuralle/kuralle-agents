import type { Tool as AiTool } from 'ai';
import type { AnyTool } from '../../types/effectTool.js';
import type { ToolContext } from '../../types/run-context.js';

export function wrapAiSdkTool(name: string, aiTool: AiTool): AnyTool {
  const exec = (aiTool as { execute?: (a: unknown, c?: unknown) => unknown }).execute;
  if (typeof exec !== 'function') {
    throw new Error(
      `wrapAiSdkTool("${name}"): AI SDK tool has no execute; use defineTool for schema-only tools.`,
    );
  }
  return {
    name,
    description: aiTool.description ?? name,
    input: (aiTool as { inputSchema?: AnyTool['input'] }).inputSchema,
    execute: (args, ctx?: ToolContext) => exec(args, ctx) as Promise<unknown>,
  } as AnyTool;
}
