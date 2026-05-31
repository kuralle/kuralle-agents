import { tool as aiTool, type ToolSet } from 'ai';
import type { ToolDeclaration } from '../index.js';

/**
 * Convert ToolDeclarations to Vercel AI SDK ToolSet format.
 *
 * ai v6 uses `inputSchema` (not `parameters`). The execute function
 * signature is `(input, options) => ...` — we ignore options since
 * ToolDeclaration.execute only takes args.
 *
 * Follows the Hare pattern: closes over context at registration time
 * so tools don't need context at call time.
 */
export function toAISDKTools(tools: ToolDeclaration[]): ToolSet {
  return Object.fromEntries(
    tools.map(t => [
      t.name,
      aiTool({
        description: t.description,
        inputSchema: t.parameters,
        execute: async (args: unknown, options?: unknown) => {
          try {
            return await t.execute(args, options);
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    ])
  );
}
