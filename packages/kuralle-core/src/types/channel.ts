import type { ToolSet } from 'ai';
import type { RunContext } from './run-context.js';
import type { FlowNode } from './flow.js';
import type { Tool, AnyTool } from './effectTool.js';

export interface ResolvedNode {
  node: FlowNode;
  prompt: string;
  tools: ToolSet;
  localTools?: Record<string, AnyTool>;
}

export interface ChannelDriver {
  runAgentTurn(node: ResolvedNode, ctx: RunContext): Promise<TurnResult>;
  awaitUser(ctx: RunContext): Promise<UserSignal>;
  runStructured?(node: Extract<FlowNode, { kind: 'decide' }>, ctx: RunContext): Promise<unknown>;
}

export interface TurnResult {
  text: string;
  toolResults: ToolResultRecord[];
  control?: TurnControl;
  interrupted?: boolean;
  truncateAt?: number;
  confidence?: number;
}

export type UserSignal = { type: 'message'; input: string };

export interface ToolResultRecord {
  name: string;
  args: unknown;
  result: unknown;
  toolCallId?: string;
}

export type TurnControl =
  | { type: 'handoff'; target: string; reason?: string }
  | { type: 'end'; reason: string };
