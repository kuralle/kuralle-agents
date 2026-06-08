import type { ToolSet } from 'ai';
import type { RunContext } from './run-context.js';
import type { FlowNode } from './flow.js';
import type { Tool, AnyTool } from './effectTool.js';

export interface ResolvedNode {
  node: FlowNode;
  prompt: string;
  tools: ToolSet;
  localTools?: Record<string, AnyTool>;
  /** Free-conversation reply (host loop): keeps model control tools even when outOfBandControl is on. */
  freeConversation?: boolean;
}

export interface ChannelDriver {
  runAgentTurn(node: ResolvedNode, ctx: RunContext): Promise<TurnResult>;
  awaitUser(ctx: RunContext): Promise<UserSignal>;
  runStructured?(node: Extract<FlowNode, { kind: 'decide' }>, ctx: RunContext): Promise<unknown>;
  /** Non-speaking field extraction for `collect` nodes: runs the submit tool to
   *  pull structured fields but MUST NOT emit any user-facing text (no
   *  text-delta, no spoken transcript). The returned `text` is ignored by the
   *  flow engine. This is the structural backstop that stops a collect turn from
   *  authoring narration that contradicts flow state. Drivers without it fall
   *  back to runAgentTurn, whose text the engine then discards. */
  runExtraction?(node: ResolvedNode, ctx: RunContext): Promise<TurnResult>;
}

export interface TurnResult {
  text: string;
  toolResults: ToolResultRecord[];
  control?: TurnControl;
  interrupted?: boolean;
  truncateAt?: number;
  confidence?: number;
  /** Native realtime post-hoc gate: provider audio already played; gate is advisory only. */
  gateScope?: 'advisory';
}

export type UserSignal = { type: 'message'; input: string };

interface ToolResultRecord {
  name: string;
  args: unknown;
  result: unknown;
  toolCallId?: string;
}

export type TurnControl =
  | { type: 'handoff'; target: string; reason?: string }
  | { type: 'enterFlow'; flowName: string; reason?: string }
  | { type: 'end'; reason: string }
  | { type: 'escalate'; reason: string }
  | { type: 'recover'; reason?: string };
