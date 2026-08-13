import { jsonSchema as toAiJsonSchema } from 'ai';
import type { StandardSchemaV1 } from '../../types/standard-schema.js';
import type { JsonSchema } from './types.js';

export type UnsupportedSchemaMode = 'throw' | 'warn';

export interface JsonSchemaAdapter extends StandardSchemaV1 {
  readonly validated: false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function adaptJsonSchema(
  schema: JsonSchema,
  path: string,
  onUnsupportedSchema: UnsupportedSchemaMode,
): JsonSchemaAdapter {
  if (!isPlainRecord(schema)) {
    const message = `Unsupported schema at ${path}: expected a JSON Schema object`;
    if (onUnsupportedSchema === 'throw') {
      throw new Error(message);
    }
    console.warn(message);
    return passthroughAdapter({});
  }
  return passthroughAdapter(schema);
}

function passthroughAdapter(schema: JsonSchema): JsonSchemaAdapter {
  const modelFacing = toAiJsonSchema(schema as Parameters<typeof toAiJsonSchema>[0]);
  const adapter = {
    '~standard': {
      version: 1 as const,
      vendor: 'kuralle-flow-definition',
      validate: (value: unknown): StandardSchemaV1.Result<unknown> => ({ value }),
      jsonSchema: {
        input: (_options?: { target?: string }) => {
          const json = modelFacing.jsonSchema;
          if (typeof json === 'object' && json !== null && 'then' in json) {
            return schema;
          }
          return json ?? schema;
        },
      },
    },
    validated: false as const,
  };
  return adapter;
}

export function jsonSchemaRequiredFields(schema: JsonSchema): string[] | undefined {
  if (Array.isArray(schema.required) && schema.required.every((key) => typeof key === 'string')) {
    return schema.required as string[];
  }
  if (isPlainRecord(schema.properties)) {
    return Object.keys(schema.properties);
  }
  return undefined;
}
