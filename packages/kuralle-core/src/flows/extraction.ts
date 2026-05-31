import { generateText, Output, type LanguageModel, type ModelMessage, type TelemetrySettings } from 'ai';
import { z, type ZodTypeAny } from 'zod';

const DEFAULT_EXTRACTION_PROMPT =
  'Extract only facts explicitly stated in the latest user message. Do not infer or invent missing values.';

export type StructuredExtractionOutput<TSchema extends ZodTypeAny> = TSchema['_output'];

export interface StructuredExtractionOptions<TSchema extends ZodTypeAny> {
  model: LanguageModel;
  schema: TSchema;
  userMessage: string;
  systemPrompt?: string;
  contextMessages?: ModelMessage[];
  telemetry?: TelemetrySettings;
  abortSignal?: AbortSignal;
}

export async function extractStructuredFields<TSchema extends ZodTypeAny>(
  options: StructuredExtractionOptions<TSchema>
): Promise<StructuredExtractionOutput<TSchema>> {
  const { model, schema, userMessage, systemPrompt, contextMessages, telemetry, abortSignal } = options;
  const messages: ModelMessage[] = [];
  if (Array.isArray(contextMessages) && contextMessages.length > 0) {
    messages.push(...contextMessages);
  }
  messages.push({ role: 'user', content: userMessage } as ModelMessage);

  const { output } = await generateText({
    model,
    output: Output.object({ schema }),
    system: systemPrompt?.trim() || DEFAULT_EXTRACTION_PROMPT,
    messages,
    abortSignal,
    experimental_telemetry: telemetry,
  });

  return output as StructuredExtractionOutput<TSchema>;
}

/**
 * Build a tool/input schema for extraction submissions.
 *
 * Unlike the completion schema, extraction submissions must allow partial
 * payloads so the model can report only explicitly collected fields instead of
 * fabricating placeholder values to satisfy required constraints.
 */
export function toExtractionSubmissionSchema(schema: ZodTypeAny): ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const nullableShape: Record<string, ZodTypeAny> = {};
    for (const [key, fieldSchema] of Object.entries(schema.shape)) {
      nullableShape[key] = (fieldSchema as ZodTypeAny).nullable().optional();
    }
    return z.object(nullableShape);
  }

  return schema.nullable().optional();
}

export function mergeExtractionData(
  current: Record<string, unknown>,
  extracted: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const next = { ...current };
  if (!extracted) return next;

  for (const [key, value] of Object.entries(extracted)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    next[key] = value;
  }
  return next;
}

export function computeMissingFields(
  data: Record<string, unknown>,
  requiredFields: readonly string[]
): string[] {
  return requiredFields.filter(field => {
    const value = data[field];
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    if (Array.isArray(value)) return value.length === 0;
    return false;
  });
}

export function buildMissingFieldsMessage(missingFields: readonly string[]): string {
  if (missingFields.length === 0) {
    return '';
  }
  if (missingFields.length === 1) {
    return `I still need: ${missingFields[0]}.`;
  }
  return `I still need: ${missingFields.join(', ')}.`;
}
