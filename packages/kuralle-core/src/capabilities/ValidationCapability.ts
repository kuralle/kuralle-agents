import type { EscalationReason } from '../escalation/types.js';
import type { Session, SourceRef, ToolCallRecord } from '../types/index.js';

export interface ValidationCapability {
  readonly name: string;
  readonly order?: 'parallel' | 'serial';
  /** Absent ⇒ `turn` (buffered, safe). Streaming is an explicit opt-in by the gate author. */
  readonly streamGranularity?: 'sentence' | 'turn';
  validate(input: ValidateInput): Promise<ValidateDecision>;
}

export interface ValidateInput {
  readonly session: Session;
  readonly userMessage: string;
  readonly assistantOutput: string;
  readonly toolCallsMade: ToolCallRecord[];
  readonly knowledgeCitations: SourceRef[];
  /** Current flow state (`runState.state`). Lets a grounding validator ground a
   *  claim against evidence an ACTION node wrote (e.g. `state.orderRef` after a
   *  create-order tool), which `toolCallsMade` (this turn's model tool calls only)
   *  does not capture. `{}` when the turn ran outside a flow. */
  readonly state: Readonly<Record<string, unknown>>;
  readonly abortSignal?: AbortSignal;
}

export type ValidateDecision =
  | { decision: 'continue'; confidence: number; rationale?: string }
  | { decision: 'rewrite'; confidence: number; rewrittenOutput: string; rationale: string }
  | {
      decision: 'escalate';
      confidence: number;
      rationale: string;
      escalateTo?: string;
      escalationReason?: EscalationReason;
      userFacingMessage?: string;
    }
  | { decision: 'block'; confidence: number; rationale: string; userFacingMessage?: string };

