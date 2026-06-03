import type { LanguageModel, ToolSet } from 'ai';
import type { AgentPrompt } from '../prompts/AgentPrompt.js';
import type { Flow } from './flow.js';
import type { Route, RoutingPolicy } from './route.js';
import type { Guardrails, Limits } from './guardrails.js';
import type { AgentKnowledge, AgentMemory } from './grounding.js';
import type { Tool, AnyTool } from './effectTool.js';

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
  tools?: ToolSet;
  effectTools?: Record<string, AnyTool>;
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
}

export function defineAgent(config: AgentConfig): AgentConfig {
  return config;
}
