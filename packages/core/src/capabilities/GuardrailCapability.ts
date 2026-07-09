import type { Capability, ToolDeclaration, PromptSection, CapabilityAction } from './index.js';

// ─── GuardrailCapability ─────────────────────────────────────────────────────

/**
 * Injects policy text into the system prompt as 'policy' sections.
 * Optionally filters input/output text — currently a passthrough placeholder
 * that future processor integration can populate.
 */
export class GuardrailCapability implements Capability {
  private policies: string[];

  constructor(policies: string[]) {
    this.policies = policies;
  }

  getTools(): ToolDeclaration[] {
    return [];
  }

  getPromptSections(): PromptSection[] {
    return this.policies
      .filter(p => p.trim().length > 0)
      .map(policy => ({ role: 'policy', content: policy }));
  }

  processToolResult(_toolName: string, _args: unknown, _result: unknown): CapabilityAction | null {
    return null;
  }

  /**
   * Evaluate whether an input text is permitted by this guardrail.
   * Returns `{ allowed: true }` until a processor is wired in.
   */
  filterInput(_text: string): { allowed: boolean; reason?: string } {
    return { allowed: true };
  }

  /**
   * Evaluate whether an output text is permitted and optionally modify it.
   * Returns `{ allowed: true }` until a processor is wired in.
   */
  filterOutput(_text: string): { allowed: boolean; modified?: string } {
    return { allowed: true };
  }
}
