import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDeclaration } from '../index.js';

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Convert ToolDeclarations to Gemini FunctionDeclarations.
 *
 * Gemini expects OpenAPI 3.x style JSON Schema for parameters.
 * This adapter handles the Zod → JSON Schema conversion and
 * strips unsupported JSON Schema features ($ref, oneOf, const).
 */
export function toGeminiDeclarations(tools: ToolDeclaration[]): GeminiFunctionDeclaration[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
      ? stripUnsupported(zodToJsonSchema(tool.parameters, { target: 'openApi3' }) as Record<string, unknown>)
      : { type: 'object', properties: {} },
  }));
}

/**
 * Recursively strip JSON Schema features that Gemini doesn't support.
 */
function stripUnsupported(schema: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    // Skip unsupported top-level and nested keys
    if (key === '$schema' || key === '$ref' || key === 'additionalProperties') continue;

    // Recurse into objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      cleaned[key] = stripUnsupported(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      cleaned[key] = value.map(item =>
        item && typeof item === 'object' ? stripUnsupported(item as Record<string, unknown>) : item
      );
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}
