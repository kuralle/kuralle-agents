import type { Session } from '../types/index.js';
import type { MemoryService } from '../memory/MemoryService.js';
import type { KnowledgeProvider } from '../runtime/KnowledgeProvider.js';
import type { EscalationReason } from '../escalation/types.js';

export interface RefinementCapability {
  readonly name: string;
  readonly order?: 'parallel' | 'serial';
  refine(input: RefineInput): Promise<RefineDecision>;
}

export interface RefineInput {
  readonly session: Session;
  readonly userMessage: string;
  readonly knowledgeProvider: KnowledgeProvider | undefined;
  readonly memoryService: MemoryService | undefined;
  readonly abortSignal?: AbortSignal;
}

export type RefineDecision =
  | { decision: 'continue'; confidence: number; rationale?: string }
  | { decision: 'rewrite'; confidence: number; rewrittenMessage: string; rationale: string }
  | { decision: 'escalate'; confidence: number; rationale: string; escalateTo?: string; escalationReason?: EscalationReason }
  | { decision: 'block'; confidence: number; rationale: string; userFacingMessage?: string };

