import type { ChoiceOption } from '../../types/selection.js';
import type { MappingConfig } from './mapping.js';
import type { Predicate } from './predicate.js';

export type JsonSchema = Record<string, unknown>;

export const FLOW_DEFINITION_NODE_KINDS = ['reply', 'collect', 'action', 'decide'] as const;
export type FlowDefinitionNodeKind = (typeof FLOW_DEFINITION_NODE_KINDS)[number];

export const PREDICATE_PATH_ROOTS = ['input', 'state', 'results', 'requestContext'] as const;
export type PredicatePathRoot = (typeof PREDICATE_PATH_ROOTS)[number];

export type TransitionRef =
  | { goto: string; data?: Record<string, unknown> }
  | { handoff: string; reason?: string }
  | { escalate: string }
  | { end: string }
  | 'stay';

export interface PredicateRoute {
  when: Predicate;
  to: TransitionRef;
}

export interface ConfirmGateRef {
  onConfirm: TransitionRef;
  onDecline: TransitionRef;
  onAmbiguous?: TransitionRef;
}

export interface CollectResolverSpec {
  field: string;
  kind: string;
}

interface ReplyNodeDefinitionBase {
  kind: 'reply';
  id: string;
  instructions?: string;
  next?: TransitionRef;
  routes?: PredicateRoute[];
}

export interface ReplyTemplateNodeDefinition extends ReplyNodeDefinitionBase {
  response: { template: string };
}

export interface ReplyGenerateNodeDefinition extends ReplyNodeDefinitionBase {
  generate: true;
}

export type ReplyNodeDefinition = ReplyTemplateNodeDefinition | ReplyGenerateNodeDefinition;

export interface CollectNodeDefinition {
  kind: 'collect';
  id: string;
  schema: JsonSchema;
  ask?: string;
  instructions?: string;
  assign?: Record<string, string>;
  resolvers?: CollectResolverSpec[];
  required?: string[];
  maxTurns?: number;
  choices?: ChoiceOption[];
  next?: TransitionRef;
}

export interface ActionNodeDefinition {
  kind: 'action';
  id: string;
  tool: string;
  args?: MappingConfig;
  bind?: string;
  approval?: true;
  next?: TransitionRef;
  routes?: PredicateRoute[];
}

export interface DecideNodeDefinition {
  kind: 'decide';
  id: string;
  instructions?: string;
  schema?: JsonSchema;
  choices?: ChoiceOption[];
  routes?: PredicateRoute[];
  otherwise?: TransitionRef;
  confirmGate?: ConfirmGateRef;
}

export type FlowNodeDefinition =
  | ReplyNodeDefinition
  | CollectNodeDefinition
  | ActionNodeDefinition
  | DecideNodeDefinition;

export interface FlowDefinition {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  start: string;
  nodes: FlowNodeDefinition[];
}
