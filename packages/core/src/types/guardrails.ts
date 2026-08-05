import type { InputProcessor, OutputProcessor } from './processors.js';
import type { EnforcementRule, ToolPolicy } from './tool.js';

export interface Guardrails {
  input?: InputProcessor[];
  output?: OutputProcessor[];
  tools?: Record<string, ToolPolicy>;
  enforcement?: EnforcementRule[];
}

export interface Limits {
  maxTurns?: number;
  maxSteps?: number;
  toolMaxSteps?: number;
  maxOscillations?: number;
  /**
   * Ceiling on parallel-safe tools executing at once within one model-emitted batch.
   * Defaults to `DEFAULT_MAX_TOOL_CONCURRENCY` (8). Raise it deliberately; the
   * model's batch size must never be the concurrency policy, and above eight the
   * session store's CAS starts rejecting concurrent writes.
   */
  maxToolConcurrency?: number;
}
