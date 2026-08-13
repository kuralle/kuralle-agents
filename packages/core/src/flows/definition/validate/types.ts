import type { JsonSchema } from '../types.js';

export type SchemaCompatibility = 'compatible' | 'incompatible' | 'unknown';

export type FlowValidationIssueCode =
  | 'duplicate-node-id'
  | 'missing-start'
  | 'unresolved-transition'
  | 'unreachable-node'
  | 'invalid-reply'
  | 'inline-transition-target'
  | 'missing-reference'
  | 'invalid-predicate-reference'
  | 'incompatible-schema'
  | 'invalid-template'
  | 'invalid-map-reference'
  | 'predicate-too-deep'
  | 'nl-predicate-compile-failed';

export type FlowValidationRepairOperation =
  | 'set-transition'
  | 'set-mapping-source'
  | 'set-predicate'
  | 'set-template'
  | 'update-node'
  | 'remove-node';

export interface FlowValidationRepairSource {
  source: { input: true; path: string } | { node: string; path: string };
  schema?: JsonSchema;
  compatibility: SchemaCompatibility;
}

export interface FlowValidationRepairAction {
  operation: FlowValidationRepairOperation;
  arguments: Record<string, string | number | boolean>;
  legalSources: FlowValidationRepairSource[];
}

export interface FlowValidationIssue {
  code: FlowValidationIssueCode;
  path: string;
  message: string;
  repair?: FlowValidationRepairAction;
}

export interface FlowRegistrySchemas {
  id?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

export interface FlowRegistryIndex {
  tools?: Record<string, FlowRegistrySchemas>;
  flows?: Record<string, FlowRegistrySchemas>;
  agents?: Record<string, FlowRegistrySchemas>;
}

export const PREDICATE_MAX_DEPTH = 32;
export const PREDICATE_MAX_NODES = 256;
