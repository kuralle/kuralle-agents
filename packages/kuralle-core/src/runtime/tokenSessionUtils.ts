import type { Session } from '../types/index.js';
import { ContextBudget, DEFAULT_CONTEXT_BUDGET, type ContextBudgetConfig } from './ContextBudget.js';
import { TokenAccumulator } from './TokenAccumulator.js';

const ACC_KEY = '__ariaTokenAccumulator';
const BUDGET_KEY = '__ariaContextBudgetValidator';

export function getOrCreateTokenAccumulator(
  session: Session,
  modelContextWindow?: number,
): TokenAccumulator {
  const existing = session.workingMemory[ACC_KEY];
  if (existing instanceof TokenAccumulator) {
    return existing;
  }
  const w = modelContextWindow ?? DEFAULT_CONTEXT_BUDGET.modelContextWindow;
  const acc = new TokenAccumulator(w);
  session.workingMemory[ACC_KEY] = acc;
  return acc;
}

export function getOrCreateContextBudgetValidator(
  session: Session,
  partial?: Partial<ContextBudgetConfig>,
): ContextBudget {
  const existing = session.workingMemory[BUDGET_KEY];
  if (existing instanceof ContextBudget) {
    return existing;
  }
  const cfg: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET, ...partial };
  const inst = new ContextBudget(cfg);
  session.workingMemory[BUDGET_KEY] = inst;
  return inst;
}
