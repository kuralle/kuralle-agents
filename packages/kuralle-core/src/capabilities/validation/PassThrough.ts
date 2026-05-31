import type { ValidateDecision, ValidationCapability } from '../ValidationCapability.js';

export class PassThroughValidation implements ValidationCapability {
  readonly name: string;
  readonly order?: 'parallel' | 'serial';

  constructor(options: { name?: string; order?: 'parallel' | 'serial' } = {}) {
    this.name = options.name ?? 'pass-through-validation';
    this.order = options.order;
  }

  async validate(): Promise<ValidateDecision> {
    return { decision: 'continue', confidence: 1 };
  }
}

