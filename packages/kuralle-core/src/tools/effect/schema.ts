import type { StandardSchemaV1 } from '../../types/standard-schema.js';

export class ToolValidationError extends Error {
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(message: string, issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(message);
    this.name = 'ToolValidationError';
    this.issues = issues;
  }
}

export async function validateAndSanitize<T>(
  schema: StandardSchemaV1 | undefined,
  value: unknown,
  toolName: string,
): Promise<T> {
  if (!schema) {
    return value as T;
  }

  const result = await schema['~standard'].validate(value);
  if ('issues' in result) {
    const message = result.issues.map((i) => i.message).join('; ') || 'Validation failed';
    throw new ToolValidationError(`Tool "${toolName}" args invalid: ${message}`, result.issues);
  }

  return result.value as T;
}

export async function validateOutput(
  schema: StandardSchemaV1 | undefined,
  value: unknown,
  toolName: string,
): Promise<unknown> {
  if (!schema) {
    return value;
  }

  const result = await schema['~standard'].validate(value);
  if ('issues' in result) {
    const message = result.issues.map((i) => i.message).join('; ') || 'Output validation failed';
    throw new ToolValidationError(`Tool "${toolName}" output invalid: ${message}`, result.issues);
  }

  return result.value;
}
