import type { LanguageModel, ToolSet } from 'ai';
import type { Instructions } from './agentConfig.js';
import type { StandardSchemaV1 } from './standard-schema.js';
import type { ContextStrategy } from './context.js';
import type { TurnResult } from './channel.js';
import type { ActionContext } from './run-context.js';
import type { NodeVerify } from '../flow/verify.js';
import type { ChoiceOption } from './selection.js';

export type FlowState = Record<string, unknown>;

export interface Flow {
  name: string;
  description: string;
  start: FlowNode | (() => FlowNode);
  nodes: FlowNode[];
  instructions?: string;
  context?: ContextStrategy;
  maxOscillations?: number;
}

export type FlowNode = ReplyNode | CollectNode | ActionNode | DecideNode;

export type Transition =
  | FlowNode
  | (() => FlowNode)
  | { goto: FlowNode | (() => FlowNode); data?: Record<string, unknown> }
  | { handoff: string; reason?: string }
  | { escalate: string }
  | { end: string }
  | 'stay';

export interface ReplyNode {
  kind: 'reply';
  id: string;
  instructions: Instructions;
  tools?: ToolSet | ((state: FlowState) => ToolSet);
  model?: LanguageModel;
  context?: ContextStrategy;
  next?: (turn: TurnResult, state: FlowState) => Transition | Promise<Transition>;
}

export interface CollectNode {
  kind: 'collect';
  id: string;
  schema: StandardSchemaV1;
  required?: string[];
  /** Extraction-only guidance for the (non-speaking) field extraction turn.
   *  This text is NEVER shown to the user — see `ask` for user-facing copy. */
  instructions?: (missing: string[], state: FlowState) => Instructions;
  /** Deterministic, framework-emitted question shown when fields are still
   *  missing. Collect extraction never speaks model-authored text, so this is
   *  the only user-facing copy a collect node produces. Must not claim any
   *  downstream outcome (order placed, delivery scheduled, payment, website). */
  ask?: (missing: string[], state: FlowState) => string;
  choices?: ChoiceOption[];
  maxTurns?: number;
  onComplete: (data: unknown, state: FlowState) => Transition | Promise<Transition>;
}

export interface ActionNode {
  kind: 'action';
  id: string;
  verify?: NodeVerify;
  outputSchema?: StandardSchemaV1;
  run: (state: FlowState, ctx: ActionContext) => Transition | Promise<Transition>;
}

export interface DecideNode {
  kind: 'decide';
  id: string;
  instructions: Instructions;
  schema: StandardSchemaV1;
  choices?: ChoiceOption[];
  decide: (data: unknown, state: FlowState) => Transition | Promise<Transition>;
}

export function reply(node: Omit<ReplyNode, 'kind'>): ReplyNode {
  return { kind: 'reply', ...node };
}

export function collect(node: Omit<CollectNode, 'kind'>): CollectNode {
  return { kind: 'collect', ...node };
}

export function action(node: Omit<ActionNode, 'kind'>): ActionNode {
  return { kind: 'action', ...node };
}

export function decide(node: Omit<DecideNode, 'kind'>): DecideNode {
  return { kind: 'decide', ...node };
}

export function defineFlow(flow: Flow): Flow {
  return flow;
}
