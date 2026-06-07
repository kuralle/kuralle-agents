import type { AnyTool } from '../../types/effectTool.js';
import type { ToolContext } from '../../types/run-context.js';

/**
 * Structural shape of an AI SDK `tool()` result. Intentionally decoupled from the
 * nominal `import('ai').Tool` type so a tool produced by *any* `ai` instance/version
 * in the consumer's tree is accepted (avoids cross-instance nominal mismatches).
 */
interface AiSdkToolLike {
  description?: string;
  inputSchema?: unknown;
  execute?: unknown;
}

/**
 * Adapt a third-party AI SDK tool into a durable Kuralle effect tool so its `execute`
 * runs through the journal (exactly-once on replay). Throws on a schema-only tool
 * (no `execute`) — use `defineTool` for those.
 */
export function wrapAiSdkTool(name: string, aiTool: AiSdkToolLike): AnyTool {
  const exec = aiTool.execute;
  if (typeof exec !== 'function') {
    throw new Error(
      `wrapAiSdkTool("${name}"): AI SDK tool has no execute; use defineTool for schema-only tools.`,
    );
  }
  const run = exec as (args: unknown, ctx?: unknown) => unknown;
  return {
    name,
    description: typeof aiTool.description === 'string' ? aiTool.description : name,
    input: aiTool.inputSchema as AnyTool['input'],
    execute: (args, ctx?: ToolContext) => run(args, ctx) as Promise<unknown>,
  } as AnyTool;
}
