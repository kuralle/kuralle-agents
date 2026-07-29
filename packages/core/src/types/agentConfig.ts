import type { LanguageModel } from 'ai';
import type { AgentPrompt } from '../prompts/AgentPrompt.js';
import type { Flow } from './flow.js';
import type { Route, RoutingPolicy } from './route.js';
import type { Guardrails, Limits } from './guardrails.js';
import type { AgentKnowledge, AgentMemory } from './grounding.js';
import type { RefinementCapability } from '../capabilities/RefinementCapability.js';
import type { ValidationCapability } from '../capabilities/ValidationCapability.js';
import type { Policy } from '../runtime/policies/toolPolicy.js';
import type { AnyTool } from './effectTool.js';
import type { FileSystem } from './filesystem.js';
import type { Shell } from './shell.js';
import type { SkillSource } from './skills.js';
import type { Session } from './session.js';

export type AgentWorkspaceDefinition =
  | FileSystem
  | {
      fs: FileSystem;
      shell?: Shell;
      readOnly?: boolean;
      /** Expose workspace mutation operations to the model. Defaults false even when executor code may write. */
      modelWritable?: boolean;
      /** Model-facing path and mount guidance appended to the workspace tool description. */
      instructions?: string;
    };

export interface AgentWorkspaceResolverContext {
  session: Session;
  agentId: string;
}

/** Resolve a tenant/session-specific workspace at turn time. */
export type AgentWorkspaceResolver = (
  context: AgentWorkspaceResolverContext,
) => AgentWorkspaceDefinition | Promise<AgentWorkspaceDefinition>;

export type AgentWorkspaceConfig = AgentWorkspaceDefinition | AgentWorkspaceResolver;

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
  /**
   * Decides allow / ask / deny for every tool call this agent makes. Overrides the runtime
   * policy. This is how a delegated worker becomes genuinely read-only: the restriction is
   * enforced at the gate, not by hoping the model respects its instructions.
   */
  policy?: Policy;
  experimental?: {
    /** Flow reply nodes: silo flow-transition control tools + deterministic evaluator (ADR 0003 H1).
     *  Default ON when the agent declares `flows`; OFF for answering-only agents. Override explicitly to opt out. */
    outOfBandControl?: boolean;
  };
  /** Portable workspace filesystem (or per-session resolver); auto-registers the durable `workspace` tool when set.
   *  Defaults to read-only. `{ fs, readOnly: false }` lets trusted executor code write while the
   *  model gets a read-only traversal surface; add `modelWritable: true` to expose write/edit/mv/rm
   *  to the model as well. Filesystem/mount enforcement remains authoritative. */
  workspace?: AgentWorkspaceConfig;
  /** Bundled procedural skills (Anthropic Agent Skill model): Level-1 name+description in prompt,
   *  body via `load_skill`, resources via `read_skill_resource`. Scripts = `allowedTools` only. */
  skills?: SkillSource;
}

export function defineAgent(config: AgentConfig): AgentConfig {
  return config;
}
