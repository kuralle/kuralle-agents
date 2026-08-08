import type { Tool } from '@kuralle-agents/core';

const VENDOR = 'kuralle-mcp-json-schema';

type ToolInputSchema = NonNullable<Tool['input']>;

/**
 * Wraps a remote MCP tool inputSchema for defineTool / the AI SDK.
 *
 * - The original JSON Schema is forwarded to the model via Standard JSON Schema conversion.
 * - Local validation is a pass-through so we never reject input the remote schema would accept.
 *   Constructs we cannot faithfully validate (oneOf, $ref, patternProperties, etc.) therefore
 *   reach the MCP server unchanged for authoritative validation.
 */
export function remoteMcpInputSchema(
  schema: Record<string, unknown> | undefined,
): ToolInputSchema {
  const remote =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? schema
      : { type: 'object', properties: {} };

  return {
    '~standard': {
      version: 1,
      vendor: VENDOR,
      validate: (value: unknown) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          return { value: value as Record<string, unknown> };
        }
        if (value === undefined) {
          return { value: {} };
        }
        return { value: { value } as Record<string, unknown> };
      },
      jsonSchema: {
        input: () => remote,
        output: () => remote,
      },
      types: {
        input: {} as Record<string, unknown>,
        output: {} as Record<string, unknown>,
      },
    },
  } as ToolInputSchema;
}
