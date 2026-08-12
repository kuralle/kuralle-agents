import type { FlowDefinition } from '../types.js';
import { addFlowValidationRepairActions } from './repair.js';
import { validateFlowRefs } from './refs.js';
import { inferGraphSchemas } from './schema-flow.js';
import { validateFlowStructure } from './structure.js';
import type { FlowRegistryIndex, FlowValidationIssue } from './types.js';

export type {
  FlowRegistryIndex,
  FlowRegistrySchemas,
  FlowValidationIssue,
  FlowValidationIssueCode,
  FlowValidationRepairAction,
  FlowValidationRepairOperation,
  FlowValidationRepairSource,
  SchemaCompatibility,
} from './types.js';
export { PREDICATE_MAX_DEPTH, PREDICATE_MAX_NODES } from './types.js';
export { validateFlowStructure } from './structure.js';
export { validateFlowRefs } from './refs.js';
export { inferGraphSchemas } from './schema-flow.js';
export type { GraphSchemaInference } from './schema-flow.js';
export { schemaCompatibility } from './schema-utils.js';

export function validateFlowDefinition(
  def: FlowDefinition,
  index: FlowRegistryIndex = {},
): FlowValidationIssue[] {
  const inference = inferGraphSchemas(def, index);
  return addFlowValidationRepairActions(
    def,
    index,
    [...validateFlowStructure(def), ...validateFlowRefs(def, index), ...inference.issues],
    inference,
  );
}

export function assertValidFlowDefinition(def: FlowDefinition, index: FlowRegistryIndex = {}): void {
  const issues = validateFlowDefinition(def, index);
  if (issues.length === 0) return;
  const details = issues.map((issue) => `- [${issue.code}] ${issue.path}: ${issue.message}`).join('\n');
  throw new Error(`Flow definition "${def.name}" failed validation with ${issues.length} issue(s):\n${details}`);
}
