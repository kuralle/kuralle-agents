import type { Session, SourceRef, ToolCallRecord } from '../types/index.js';

export interface ValidationCapability {
  readonly name: string;
  readonly order?: 'parallel' | 'serial';
  validate(input: ValidateInput): Promise<ValidateDecision>;
}

export interface ValidateInput {
  readonly session: Session;
  readonly userMessage: string;
  readonly assistantOutput: string;
  readonly toolCallsMade: ToolCallRecord[];
  readonly knowledgeCitations: SourceRef[];
  readonly abortSignal?: AbortSignal;
}

export type ValidateDecision =
  | { decision: 'continue'; confidence: number; rationale?: string }
  | { decision: 'rewrite'; confidence: number; rewrittenOutput: string; rationale: string }
  | { decision: 'block'; confidence: number; rationale: string; userFacingMessage?: string };

