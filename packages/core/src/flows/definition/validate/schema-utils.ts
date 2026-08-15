import type { JsonSchema } from '../types.js';
import type { SchemaCompatibility } from './types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumeric(sourceType: string, destinationType: string): boolean {
  const numeric = new Set(['integer', 'number']);
  return numeric.has(sourceType) && numeric.has(destinationType);
}

export function schemaCompatibility(source: unknown, destination: unknown): SchemaCompatibility {
  if (!isRecord(source) || !isRecord(destination)) return 'unknown';
  const sourceType = typeof source.type === 'string' ? source.type : undefined;
  const destinationType = typeof destination.type === 'string' ? destination.type : undefined;
  if (!sourceType || !destinationType) return 'unknown';
  if (sourceType !== destinationType && !isNumeric(sourceType, destinationType)) return 'incompatible';
  if (destinationType === 'array') return schemaCompatibility(source.items, destination.items);
  if (destinationType !== 'object') return 'compatible';

  const sourceProperties = isRecord(source.properties) ? source.properties : {};
  const destinationProperties = isRecord(destination.properties) ? destination.properties : {};
  const required = Array.isArray(destination.required)
    ? destination.required.filter((key): key is string => typeof key === 'string')
    : [];
  for (const key of required) {
    if (!(key in sourceProperties)) return 'incompatible';
  }
  for (const [key, destinationProperty] of Object.entries(destinationProperties)) {
    if (!(key in sourceProperties)) continue;
    if (schemaCompatibility(sourceProperties[key], destinationProperty) === 'incompatible') return 'incompatible';
  }
  return 'compatible';
}

export type PathExistence = 'exists' | 'missing' | 'unknown';

export function pathExistence(schema: JsonSchema | undefined, path: string): PathExistence {
  if (!schema) return 'unknown';
  if (path === '' || path === '.') return 'exists';
  let current: unknown = schema;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return 'unknown';
    if (typeof current.type === 'string' && current.type !== 'object') return 'missing';
    if (!isRecord(current.properties)) return 'unknown';
    if (!(segment in current.properties)) return 'missing';
    current = current.properties[segment];
  }
  return isRecord(current) ? 'exists' : 'unknown';
}

export function schemaAtPath(schema: JsonSchema | undefined, path: string): JsonSchema | undefined {
  if (!schema || path === '' || path === '.') return schema;
  let current: unknown = schema;
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !isRecord(current.properties) || !isRecord(current.properties[segment])) {
      return undefined;
    }
    current = current.properties[segment];
  }
  return current as JsonSchema;
}

export function isCanonicalScopedPath(path: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(path);
}

export function schemaForValue(value: unknown): JsonSchema {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array' };
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return { type: typeof value };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'object':
      return { type: 'object' };
    default:
      return {};
  }
}

export function emptyObjectSchema(): JsonSchema {
  return { type: 'object', properties: {} };
}

export function unionObjectSchemas(left: JsonSchema, right: JsonSchema): JsonSchema {
  const leftProps = isRecord(left.properties) ? left.properties : undefined;
  const rightProps = isRecord(right.properties) ? right.properties : undefined;
  if (!leftProps || !rightProps) return { type: 'object' };
  const properties: Record<string, JsonSchema> = {};
  for (const [key, schema] of Object.entries(leftProps)) {
    if (isRecord(schema)) properties[key] = schema as JsonSchema;
  }
  for (const [key, schema] of Object.entries(rightProps)) {
    if (!isRecord(schema)) continue;
    const existing = properties[key];
    properties[key] = existing ? unionObjectSchemas(existing, schema as JsonSchema) : (schema as JsonSchema);
  }
  const leftRequired = Array.isArray(left.required)
    ? left.required.filter((key): key is string => typeof key === 'string')
    : [];
  const rightRequired = new Set(
    Array.isArray(right.required) ? right.required.filter((key): key is string => typeof key === 'string') : [],
  );
  const required = leftRequired.filter((key) => rightRequired.has(key) && key in properties);
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function setSchemaPath(root: JsonSchema, path: string, value: JsonSchema): JsonSchema {
  if (path === '' || path === '.') return value;
  const segments = path.split('.');
  const next: JsonSchema = {
    type: 'object',
    properties: { ...(isRecord(root.properties) ? root.properties : {}) },
    ...(Array.isArray(root.required) ? { required: [...root.required] } : {}),
  };
  const properties = next.properties as Record<string, JsonSchema>;
  const [head, ...rest] = segments;
  if (!head) return value;
  if (rest.length === 0) {
    properties[head] = value;
    return next;
  }
  const child = isRecord(properties[head]) ? (properties[head] as JsonSchema) : emptyObjectSchema();
  properties[head] = setSchemaPath(child, rest.join('.'), value);
  return next;
}
