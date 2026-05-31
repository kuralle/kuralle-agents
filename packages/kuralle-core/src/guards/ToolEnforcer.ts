import type {
  EnforcementContext,
  EnforcementResult,
  EnforcementRule,
  ToolCallRecord,
} from '../types/index.js';
import { debug } from '../debug.js';

export class ToolEnforcer {
  private rules: EnforcementRule[] = [];

  constructor(rules: EnforcementRule[] = []) {
    this.rules = rules;
  }

  addRule(rule: EnforcementRule): void {
    this.rules.push(rule);
  }

  removeRule(name: string): boolean {
    const index = this.rules.findIndex(rule => rule.name === name);
    if (index >= 0) {
      this.rules.splice(index, 1);
      return true;
    }
    return false;
  }

  async check(call: ToolCallRecord, context: EnforcementContext): Promise<EnforcementResult> {
    return this.evaluate(call, context, 'call');
  }

  async checkResult(call: ToolCallRecord, context: EnforcementContext): Promise<EnforcementResult> {
    return this.evaluate(call, context, 'result');
  }

  private async evaluate(
    call: ToolCallRecord,
    context: EnforcementContext,
    phase: 'call' | 'result'
  ): Promise<EnforcementResult> {
    for (const rule of this.rules) {
      const rulePhase = rule.phase ?? 'call';
      if (phase === 'call' && rulePhase === 'result') {
        continue;
      }
      if (phase === 'result' && rulePhase === 'call') {
        continue;
      }

      if (rule.appliesTo !== '*' && !rule.appliesTo.includes(call.toolName)) {
        continue;
      }

      const result = await Promise.resolve(rule.check(call, context));

      if (!result.allowed) {
        debug(`[Enforcement] Rule "${rule.name}" blocked ${call.toolName}: ${result.reason}`);
        return result;
      }

      if (result.reminder) {
        debug(`[Enforcement] Reminder for ${call.toolName}: ${result.reminder}`);
      }
    }

    return { allowed: true };
  }

  getRules(): EnforcementRule[] {
    return [...this.rules];
  }
}

export function createToolEnforcer(rules?: EnforcementRule[]): ToolEnforcer {
  return new ToolEnforcer(rules);
}
