import type { AnyTool, Tool } from '@kuralle-agents/core';
import type { McpOptions } from './types.js';

type ToolInputSchema = NonNullable<Tool['input']>;

function inputSchemaJson(tool: AnyTool): string | null {
  const input = tool.input as ToolInputSchema | undefined;
  const standard = input?.['~standard'] as
    | (ToolInputSchema['~standard'] & {
        jsonSchema?: {
          input: (options: { target: string }) => Record<string, unknown>;
        };
      })
    | undefined;
  const jsonSchema = standard?.jsonSchema;
  if (!jsonSchema) {
    return null;
  }
  return JSON.stringify(jsonSchema.input({ target: 'draft-07' }));
}

/**
 * MCP-related system prompt surface. Task 8 adds disclosure budget behaviour via
 * `opts.disclosure`; this function never includes server-advertised instructions.
 */
export function composeMcpSystemPrompt(
  tools: Record<string, AnyTool>,
  _opts?: Pick<McpOptions, 'disclosure'>,
): string {
  const parts: string[] = [];
  for (const tool of Object.values(tools)) {
    parts.push(tool.description);
    const schemaText = inputSchemaJson(tool);
    if (schemaText) {
      parts.push(schemaText);
    }
  }
  return parts.join('\n');
}
