import type { RefineDecision, RefinementCapability } from '../RefinementCapability.js';

export class PassThroughRefinement implements RefinementCapability {
  readonly name: string;
  readonly order?: 'parallel' | 'serial';

  constructor(options: { name?: string; order?: 'parallel' | 'serial' } = {}) {
    this.name = options.name ?? 'pass-through-refinement';
    this.order = options.order;
  }

  async refine(): Promise<RefineDecision> {
    return { decision: 'continue', confidence: 1 };
  }
}

