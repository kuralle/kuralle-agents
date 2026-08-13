import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import type { Instructions } from './agentConfig.js';
import type { AgentKnowledgeOverrides } from './knowledge.js';
import type { StandardSchemaV1 } from './standard-schema.js';
import type { ContextStrategy } from './context.js';
import type { TurnResult } from './channel.js';
import type { ActionContext } from './run-context.js';
import type { NodeVerify } from '../flow/verify.js';
import type { ChoiceOption } from './selection.js';
import type { CollectResolverSpec, FlowGateSpec } from '../flows/definition/types.js';
import { assertValidCodeFlow } from '../flows/definition/validate/code-flow.js';

export type { CollectResolverSpec };
export type { SlotSource, FlowGateSpec } from '../flows/definition/types.js';

export type FlowState = Record<string, unknown>;

export interface FlowStateBoundary {
  /** Maps parent/root state into a new isolated frame. Omitted means no inbound state. */
  input?: (source: Readonly<FlowState>) => FlowState;
  /** Selects values exported to the parent/root frame on successful completion. */
  output?: (state: Readonly<FlowState>) => Record<string, unknown>;
}

export interface Flow {
  name: string;
  description: string;
  start: FlowNode | (() => FlowNode);
  nodes: FlowNode[];
  instructions?: string;
  context?: ContextStrategy;
  maxOscillations?: number;
  /** How this flow was produced. Omitted on code-authored `defineFlow` graphs. */
  origin?: 'definition' | 'code';
  /** Store version this live flow was published as. Absent on code-authored flows. */
  versionId?: string;
  /** Explicit state mapping at flow boundaries. The active frame is otherwise isolated. */
  state?: FlowStateBoundary;
  /** Post-run checks evaluated against the run record when this flow reaches a terminal transition. */
  gates?: FlowGateSpec[];
  /**
   * Enter this flow directly when routing says it owns the request, instead of
   * offering `enter_flow` and letting the model choose.
   *
   * Entry is model-discretionary by default, and the model reliably prefers to
   * converse: measured on an agent whose ONLY tool was `enter_flow`, it still
   * talked for four turns, gathered every field itself, and entered the flow only
   * once nothing was left to collect. A `collect` node's schema, `required`,
   * `maxTurns` and deterministic `ask` therefore almost never run.
   *
   * Set this when those must actually execute — an intake form, a compliance
   * step, anything where "the model handled it conversationally" is not good
   * enough. Costs one routing call per turn on agents that use it; agents that do
   * not are unaffected.
   */
  binding?: boolean;
}

export type FlowNode = ReplyNode | CollectNode | ActionNode | DecideNode;

/** Which tool layers a reply node exposes to the model. Default `'open'`. */
export type NodeToolScope =
  | 'open' // node + workingMemory + globalTools + agent.tools
  | 'base' // node + workingMemory + globalTools
  | 'closed'; // node tools only

/** Per-node retrieval/memory scoping (W3). All optional; omitting `grounding`
 *  entirely leaves the node grounded exactly as the agent-wide default. */
export interface NodeGrounding {
  /** Retrieval/memory query for this node. A fixed topic string, or a function
   *  over current flow state + message history. Defaults to the last user message. */
  query?: string | ((state: FlowState, history: ModelMessage[]) => string);
  /** Node-scoped knowledge overrides, merged OVER the agent's (node wins). Most
   *  useful: `filter` (restrict to a node-specific doc subset) and `autoRetrieve:false`
   *  to skip retrieval for this node. `topK`/`maxOutputTokens` also honored. */
  knowledge?: AgentKnowledgeOverrides & { autoRetrieve?: boolean };
  /** Node-scoped memory: `preload:false` skips memory preload for this node;
   *  `tokenBudget` overrides the agent default for this node only. */
  memory?: { preload?: boolean; tokenBudget?: number };
}

export type Transition =
  | FlowNode
  | { goto: string; data?: Record<string, unknown> }
  | { handoff: string; reason?: string }
  | { escalate: string }
  | { end: string }
  | 'stay';

export interface NodeVerification {
  verify?: NodeVerify;
  outputSchema?: StandardSchemaV1;
}

export interface ReplyNode extends NodeVerification {
  kind: 'reply';
  id: string;
  instructions: Instructions;
  /** Framework-emitted text for transactional outcomes that must not be model-authored. */
  response?: (state: Readonly<FlowState>) => string;
  tools?: ToolSet | ((state: FlowState) => ToolSet);
  /** Which tool layers the model sees on this node. Default `'open'`. */
  toolScope?: NodeToolScope;
  model?: LanguageModel;
  context?: ContextStrategy;
  grounding?: NodeGrounding;
  /** When set, routes to `onLow` when post-turn validation confidence is below `min`. */
  confidenceGate?: { min: number; onLow: Transition };
  next?: (turn: TurnResult, state: FlowState) => Transition | Promise<Transition>;
}

export interface CollectNode extends NodeVerification {
  kind: 'collect';
  id: string;
  schema: StandardSchemaV1;
  /**
   * Field names used for deterministic missing-field prompts. Zod object schemas expose
   * these automatically; other Standard Schema implementations should declare them.
   * Completion still validates the complete object asynchronously either way.
   */
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
  /** Deterministic tier-0 slot resolvers. A field resolved here is excluded from the model schema this turn. */
  resolvers?: CollectResolverSpec[];
  onComplete: (data: unknown, state: FlowState) => Transition | Promise<Transition>;
}

export interface ActionNode extends NodeVerification {
  kind: 'action';
  id: string;
  run: (state: FlowState, ctx: ActionContext) => Transition | Promise<Transition>;
}

export interface ConfirmGate {
  onConfirm: Transition;
  onDecline: Transition;
  onAmbiguous?: Transition;
}

export interface DecideNode extends NodeVerification {
  kind: 'decide';
  id: string;
  instructions: Instructions;
  schema?: StandardSchemaV1;
  choices?: ChoiceOption[];
  confirmGate?: ConfirmGate;
  decide?: (data: unknown, state: FlowState) => Transition | Promise<Transition>;
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

export function decide(
  node: Omit<DecideNode, 'kind' | 'confirmGate'> & Required<Pick<DecideNode, 'schema' | 'decide'>>,
): DecideNode {
  return { kind: 'decide', ...node };
}

export function confirmGate(node: {
  id: string;
  instructions: Instructions;
  onConfirm: Transition;
  onDecline: Transition;
  onAmbiguous?: Transition;
  choices?: ChoiceOption[];
}): DecideNode {
  return {
    kind: 'decide',
    id: node.id,
    instructions: node.instructions,
    choices: node.choices,
    confirmGate: {
      onConfirm: node.onConfirm,
      onDecline: node.onDecline,
      onAmbiguous: node.onAmbiguous,
    },
  };
}

export function defineFlow(flow: Flow): Flow {
  assertValidCodeFlow(flow);
  return flow;
}
