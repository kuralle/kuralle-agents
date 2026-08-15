import { z } from 'zod';
import type { ChoiceOption } from '../../types/selection.js';
import type { MappingConfig } from './mapping.js';
import { predicateSchema, type Predicate } from './predicate.js';
import type { CollectResolverSpec, FlowGateSpec } from './types.js';

export const nlPredicateSchema = z.object({ nl: z.string().min(1) }).strict();
export type NlPredicate = z.infer<typeof nlPredicateSchema>;
export const authoringPredicateSchema: z.ZodType<Predicate | NlPredicate> = z.union([
  predicateSchema,
  nlPredicateSchema,
]);

export function isNlPredicate(value: unknown): value is NlPredicate {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { nl?: unknown }).nl === 'string'
  );
}

type JsonSchema = Record<string, unknown>;

type TransitionRef =
  | { goto: string; data?: Record<string, unknown> }
  | { handoff: string; reason?: string }
  | { escalate: string }
  | { end: string }
  | 'stay';

interface AuthoringPredicateRoute {
  when: Predicate | NlPredicate;
  to: TransitionRef;
  whenSource?: string;
}

interface ConfirmGateRef {
  onConfirm: TransitionRef;
  onDecline: TransitionRef;
  onAmbiguous?: TransitionRef;
}

interface ReplyNodeDefinitionBase {
  kind: 'reply';
  id: string;
  instructions?: string;
  next?: TransitionRef;
  routes?: AuthoringPredicateRoute[];
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
  verbatimFields?: string[];
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
  routes?: AuthoringPredicateRoute[];
}

export interface AuthoringDecideNode {
  kind: 'decide';
  id: string;
  instructions?: string;
  schema?: JsonSchema;
  choices?: ChoiceOption[];
  routes?: AuthoringPredicateRoute[];
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
  gates?: FlowGateSpec[];
}
