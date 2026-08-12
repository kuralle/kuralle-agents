import type { ChoiceOption } from '../../types/selection.js';
import type { MappingConfig } from './mapping.js';
import type { Predicate } from './predicate.js';

type JsonSchema = Record<string, unknown>;

type TransitionRef =
  | { goto: string; data?: Record<string, unknown> }
  | { handoff: string; reason?: string }
  | { escalate: string }
  | { end: string }
  | 'stay';

interface PredicateRoute {
  when: Predicate;
  to: TransitionRef;
}

interface ConfirmGateRef {
  onConfirm: TransitionRef;
  onDecline: TransitionRef;
  onAmbiguous?: TransitionRef;
}

interface CollectResolverSpec {
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

export interface AuthoringReplyTemplateNode extends ReplyNodeDefinitionBase {
  response: { template: string };
}

export interface AuthoringReplyGenerateNode extends ReplyNodeDefinitionBase {
  generate: true;
}

export type AuthoringReplyNode = AuthoringReplyTemplateNode | AuthoringReplyGenerateNode;

export interface AuthoringCollectNode {
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

export interface AuthoringActionNode {
  kind: 'action';
  id: string;
  tool: string;
  args?: MappingConfig;
  bind?: string;
  approval?: true;
  next?: TransitionRef;
  routes?: PredicateRoute[];
}

export interface AuthoringDecideNode {
  kind: 'decide';
  id: string;
  instructions?: string;
  schema?: JsonSchema;
  choices?: ChoiceOption[];
  routes?: PredicateRoute[];
  otherwise?: TransitionRef;
  confirmGate?: ConfirmGateRef;
}

export type AuthoringFlowNodeDefinition =
  | AuthoringReplyNode
  | AuthoringCollectNode
  | AuthoringActionNode
  | AuthoringDecideNode;

export interface AuthoringFlowDefinition {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  start: string;
  nodes: AuthoringFlowNodeDefinition[];
}
