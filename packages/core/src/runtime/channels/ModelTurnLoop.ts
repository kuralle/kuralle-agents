import type { LanguageModel, ModelMessage, SystemModelMessage, ToolSet } from 'ai';
import type { TurnControl, TurnResult, ToolResultRecord } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ResolvedNode, TurnUsageSnapshot } from '../../types/channel.js';
import type { ToolCallRecord } from '../../types/session.js';
import type { TurnIncompletePayload } from '../../types/stream.js';

/**
 * Stable boundary between Kuralle's turn-composition pipeline and a model/tool
 * loop implementation. Drivers may replace this loop, but they do not own
 * policies, gather, output gating, host control, persistence, or flow state.
 */
export interface ModelTurnLoopInput {
  purpose: 'speaking' | 'extraction';
  node: ResolvedNode;
  ctx: RunContext;
  model: LanguageModel;
  messages: ModelMessage[];
  system: SystemModelMessage[];
  volatileSystemBlocks: Array<string | undefined>;
  tools?: ToolSet;
  maxSteps: number;
  temperature?: number;
  /** Optional early-stop condition used by silent typed extraction. */
  stopAfterToolResults?: (state: ModelTurnLoopState) => boolean | Promise<boolean>;
}

/**
 * Mutable per-call state shared with the outer speaking pipeline. A loop must
 * update it as tool calls settle so host-control and sentence gates can observe
 * the current turn without waiting for a second model request.
 */
export interface ModelTurnLoopState {
  toolResults: ToolResultRecord[];
  toolCallsMade: ToolCallRecord[];
  toolMessages: ModelMessage[];
  control?: TurnControl;
  usage?: TurnUsageSnapshot;
  /** Set when the model call ended on an abnormal `FinishReason` rather than `stop`. */
  incomplete?: { reason: TurnIncompletePayload['reason']; step: number };
}

export interface ModelTurnLoop {
  run(
    input: ModelTurnLoopInput,
    state: ModelTurnLoopState,
    emitToken: (delta: string) => void,
  ): Promise<void>;
}

export function createModelTurnLoopState(): ModelTurnLoopState {
  return { toolResults: [], toolCallsMade: [], toolMessages: [] };
}

export function applyModelTurnLoopState(result: TurnResult, state: ModelTurnLoopState): void {
  result.toolResults = state.toolResults;
  result.control ??= state.control;
  if (state.toolMessages.length > 0) result.toolMessages = state.toolMessages;
  if (state.usage && state.usage.totalTokens > 0) result.usage = state.usage;
  if (state.incomplete) result.incomplete = state.incomplete;
}
