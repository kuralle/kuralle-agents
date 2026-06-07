/**
 * Canonical tool-schema conversion for every voice-layer consumer.
 *
 * Both `@kuralle-agents/realtime-audio` (Gemini Live declarations) and
 * `@kuralle-agents/livekit-plugin` (LiveKit LLM tool context) previously
 * duplicated near-identical Zod → JSON Schema logic. They now delegate here.
 *
 * This module only depends on `zod-to-json-schema`, which is declared as an
 * optional peer dependency. Consumers that don't use `toolSetToJsonSchema`
 * don't need it installed.
 */

import { z } from 'zod';
import type { ZodTypeAny } from 'zod';

export type SchemaTarget = 'gemini' | 'openai' | 'livekit';

/**
 * Minimal structural type for a Vercel AI SDK tool definition. We avoid
 * importing the AI SDK types directly to keep `@kuralle-agents/voice-protocol`
 * free of heavy peer deps.
 */
export interface ToolLike {
  description?: string;
  inputSchema?: unknown;
  parameters?: unknown;
}

export type ToolSetLike = Record<string, ToolLike>;

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Convert a ToolSet (AI SDK or LiveKit ToolContext) into an array of
 * JSON-Schema function declarations suitable for the named target provider.
 *
 * All three currently-supported targets (`gemini`, `openai`, `livekit`) emit
 * OpenAPI-3 style JSON Schema for the `parameters` field, matching the
 * pre-unification output of the per-package converters.
 *
 * Adapters that need provider-specific field shapes (e.g. OpenAI Realtime's
 * `{ type: 'function', function: { ... } }` envelope) should wrap this
 * output, not reimplement it.
 */
export function toolSetToJsonSchema(
  toolSet: ToolSetLike,
  target: SchemaTarget,
): FunctionDeclaration[] {
  // All three targets produce OpenAPI-3 JSON Schema today. The `target`
  // argument is retained so callers can request target-specific divergence
  // later without breaking the signature.
  void target;

  return Object.entries(toolSet).map(([name, toolDef]) => {
    const rawSchema = toolDef.inputSchema ?? toolDef.parameters;
    const parameters = rawSchema
      ? (z.toJSONSchema(rawSchema as ZodTypeAny, { target: 'openapi-3.0' }) as Record<string, unknown>)
      : { type: 'object', properties: {} };

    return {
      name,
      description: toolDef.description ?? '',
      parameters,
    };
  });
}

/**
 * Tool-schema delivery mode for LiveKit `llm.tool()` consumers.
 *
 * - `'json-schema'` (default for capable providers): pass the authority's
 *   JSON Schema through unchanged so providers see full parameter
 *   definitions. Required for OpenAI / xAI Realtime to emit correct args.
 * - `'passthrough'`: hand LiveKit a `z.object({}).passthrough()` so all
 *   args are accepted but the provider sees no schema. Used as a fallback
 *   when a provider's tool channel chokes on rich JSON Schema.
 */
export type LiveKitToolSchemaMode = 'passthrough' | 'json-schema';

/**
 * Adapt an authority-emitted JSON Schema to the value LiveKit's
 * `llm.tool({ parameters })` expects.
 *
 * In `'json-schema'` mode the JSON Schema is returned as-is when it is a
 * well-formed `{ type: 'object', ... }` payload — that is what authority
 * tool declarations normally produce.
 *
 * In `'passthrough'` mode (or as a defensive fallback when the schema is
 * missing / malformed) a `z.object({}).passthrough()` Zod schema is
 * returned so LiveKit accepts all argument shapes.
 *
 * Centralized here (instead of in `@kuralle-agents/livekit-plugin`) so any
 * voice consumer that bridges authority JSON Schema → LiveKit tools shares
 * exactly one converter.
 */
export function toLiveKitToolParameters(
  schema: Record<string, unknown> | undefined | null,
  mode: LiveKitToolSchemaMode,
): Record<string, unknown> | ZodTypeAny {
  if (mode === 'passthrough') {
    return z.object({}).passthrough() as ZodTypeAny;
  }

  if (schema && typeof schema === 'object' && schema.type === 'object') {
    return schema;
  }

  return z.object({}).passthrough() as ZodTypeAny;
}
