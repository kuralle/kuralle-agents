import type { LanguageModel } from 'ai';
import type { AgentPrompt } from '../prompts/AgentPrompt.js';
import type { Flow } from './flow.js';
import type { Route, RoutingPolicy } from './route.js';
import type { Guardrails, Limits } from './guardrails.js';
import type { AgentKnowledge, AgentMemory } from './grounding.js';
import type { RefinementCapability } from '../capabilities/RefinementCapability.js';
import type { ValidationCapability } from '../capabilities/ValidationCapability.js';
import type { AnyTool } from './effectTool.js';
import type { FileSystem } from './filesystem.js';

export type Instructions =
  | string
  | AgentPrompt
  | ((ctx: { state: Record<string, unknown> }) => Instructions | Promise<Instructions>);

export interface AgentConfig {
  id: string;
  name?: string;
  description?: string;
  instructions?: Instructions;
  model?: LanguageModel;
  /** Optional model for the control path (routing, decide, extraction), run at
   *  temperature 0 for determinism. Defaults to `model` (the speaker) when unset.
   *  Set this to pin control to a reliable provider independent of the speaker. */
  controlModel?: LanguageModel;
  /** Durable, model-callable effect tools (exactly-once on replay). Wrap raw AI SDK tools with wrapAiSdkTool(). */
  tools?: Record<string, AnyTool>;
  /** Safe, always-available tools made model-visible in EVERY speaking node turn
   *  (the agent "base layer", ADR 0001) — e.g. a returns/FAQ knowledge-base
   *  lookup the user might ask for mid-flow. This is an explicit allow-list:
   *  NEVER put consequential/mutating tools here (they must stay flow-gated), and
   *  they are not exposed during non-speaking collect extraction. */
  globalTools?: Record<string, AnyTool>;
  flows?: Flow[];
  routes?: Route[];
  routing?: RoutingPolicy;
  agents?: AgentConfig[];
  handoffs?: string[];
  knowledge?: AgentKnowledge;
  memory?: AgentMemory;
  guardrails?: Guardrails;
  limits?: Limits;
  /** Post-turn validation policies (grounding/confidence gate). Default: none. */
  validate?: ValidationCapability[];
  /** Pre-turn refinement policies. Default: none. */
  refine?: RefinementCapability[];
  experimental?: {
    /** Flow reply nodes: silo flow-transition control tools + deterministic evaluator (ADR 0003 H1). Default OFF. */
    outOfBandControl?: boolean;
  };
  /** Portable workspace filesystem; auto-registers the durable `workspace` tool when set. */
  workspace?: FileSystem;
}

export function defineAgent(config: AgentConfig): AgentConfig {
  return config;
}
