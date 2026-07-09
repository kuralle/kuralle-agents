import type { ToolCallRecord } from './session.js';

export type { ToolSet } from 'ai';

// ============================================
// TOOL POLICY & ENFORCEMENT
// ============================================

export interface ToolPolicy {
  /** If true (default), failure blocks turn success completion. */
  critical?: boolean;
  /** Action to take on execution error. Default: 'abort' for critical tools. */
  errorPolicy?: 'abort' | 'warn' | 'continue';
}

export interface EnforcementContext {
  previousCalls: ToolCallRecord[];
  currentStep: number;
  sessionState: Record<string, unknown>;
}

export interface EnforcementResult {
  allowed: boolean;
  reason?: string;
  alternative?: {
    toolName: string;
    args: unknown;
    message: string;
  };
  reminder?: string;
}

export interface EnforcementRule {
  name: string;
  description: string;
  appliesTo: string[] | '*';
  phase?: 'call' | 'result' | 'both';
  check: (call: ToolCallRecord, context: EnforcementContext) => EnforcementResult | Promise<EnforcementResult>;
}

// ============================================
// INJECTION (working memory / policy)
// ============================================

export type InjectionPriority = 'critical' | 'high' | 'medium' | 'low';
export type InjectionLevel = 'system' | 'message' | 'tool';

export interface Injection {
  id: string;
  content: string;
  priority: InjectionPriority;
  level: InjectionLevel;
  toolName?: string;
  once?: boolean;
  expiresAt?: number;
  maxUses?: number;
}
