export type {
  JsonSchema,
  FlowDefinitionNodeKind,
  PredicatePathRoot,
  TransitionRef,
  PredicateRoute,
  ConfirmGateRef,
  CollectResolverSpec,
  ReplyTemplateNodeDefinition,
  ReplyGenerateNodeDefinition,
  ReplyNodeDefinition,
  CollectNodeDefinition,
  ActionNodeDefinition,
  DecideNodeDefinition,
  FlowNodeDefinition,
  FlowDefinition,
} from './types.js';
export { FLOW_DEFINITION_NODE_KINDS, PREDICATE_PATH_ROOTS } from './types.js';

export type { PathOrLiteral, Predicate, PredicateContext } from './predicate.js';
export { predicateSchema, evaluatePredicate, derivePredicateLabel } from './predicate.js';

export type { MappingSource, MappingConfig, TemplateSyntaxIssue } from './mapping.js';
export { mappingSourceSchema, mappingConfigSchema, validateTemplateSyntax, resolveMapping, TEMPLATE_PATH_ROOTS } from './mapping.js';

export { flowNodeDefinitionSchema, flowDefinitionSchema, choiceOptionSchema } from './schema.js';
export type { ValidatableFlowNodeDefinition, ValidatableFlowDefinition } from './schema.js';

export type { FlowRehydrationDeps } from './rehydrate.js';
export {
  rehydrateFlow,
  scopeFromState,
  recordNodeResult,
  FLOW_INPUT_KEY,
  FLOW_RESULTS_KEY,
} from './rehydrate.js';
export { toStorableFlow } from './serialize.js';
export type { JsonSchemaAdapter, UnsupportedSchemaMode } from './jsonSchemaAdapter.js';
export { adaptJsonSchema } from './jsonSchemaAdapter.js';
export { renderScopeTemplate, resolveScopePath } from '../template.js';

export type {
  FlowRegistryIndex,
  FlowRegistrySchemas,
  FlowValidationIssue,
  FlowValidationIssueCode,
  FlowValidationRepairAction,
  FlowValidationRepairOperation,
  FlowValidationRepairSource,
  SchemaCompatibility,
} from './validate/index.js';
export {
  validateFlowDefinition,
  assertValidFlowDefinition,
  PREDICATE_MAX_DEPTH,
  PREDICATE_MAX_NODES,
} from './validate/index.js';

export type {
  AuthoringReplyNode,
  AuthoringCollectNode,
  AuthoringActionNode,
  AuthoringDecideNode,
  AuthoringFlowNodeDefinition,
  AuthoringFlowDefinition,
} from './authoring.js';

export type { AuthoringUnion, CanonicalUnion, ValidatableUnion } from './guards.js';
