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
}
