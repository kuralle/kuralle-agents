import type { ZodTypeAny } from 'zod';

// ─── Tool Declaration ────────────────────────────────────────────────────────

/**
 * Backend-agnostic tool declaration. Produced by capabilities,
 * consumed by adapters (Gemini, AI SDK, LiveKit).
 */
export interface ToolDeclaration<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  parameters: ZodTypeAny;
  execute: (args: TInput, options?: unknown) => Promise<TOutput>;
  /** Optional voice-only directive metadata (flow toolHints preSpeech). */
  voiceDirective?: {
    preSpeech?: 'force' | 'optional' | 'none';
    preSpeechText?: string;
  };
}

// ─── Prompt Section ──────────────────────────────────────────────────────────

/** Ordering priority for prompt sections (lower = earlier in prompt). */
const SECTION_ORDER: Record<string, number> = {
  role: 0,
  task: 1,
  state: 2,
  context: 3,
  extraction: 4,
  routing: 5,
  policy: 6,
};

export interface PromptSection {
  /**
   * Semantic role that determines ordering in the final prompt.
   * Built-in roles: 'role' > 'task' > 'state' > 'context' > 'extraction' > 'routing' > 'policy'.
   * Custom roles sort after built-in ones.
   */
  role: string;
  content: string;
}

// ─── Capability Action ───────────────────────────────────────────────────────

/**
 * Structured payload for the realtime model when an extraction submit
 * advances collection but does not yet complete the node.
 */
export interface ExtractionToolResponseEnvelope {
  accepted: true;
  fieldsReceived: string[];
  fieldsStillRequired: string[];
  instruction: string;
}

/** Optional metadata when the flow transitions to a new node (reconfigure). */
export interface FlowReconfigureTransition {
  from: string;
  to: string;
  /** Extraction submit tool that triggered transition to `to`, when applicable. */
  triggerTool?: string;
}

/**
 * Returned by `Capability.processToolResult()` to tell the host what to do.
 */
export type CapabilityAction =
  | { type: 'continue'; toolResponseOverride?: ExtractionToolResponseEnvelope }
  | { type: 'reconfigure'; transition?: FlowReconfigureTransition }
  | { type: 'handoff'; targetAgent: string; reason?: string }
  | { type: 'end'; reason?: string }
  | { type: 'extraction-complete'; data: Record<string, unknown> };

// ─── Capability Interface ────────────────────────────────────────────────────

/**
 * A Capability is a self-contained unit of agent behavior that exposes
 * its features as tools and prompt sections. Any LLM backend that supports
 * tool calling can drive it.
 *
 * The Capability interface follows the Component pattern: each feature
 * (flows, triage, extraction, handoffs, guardrails) is a capability that
 * plugs into a CapabilityHost. The host collects tools, builds prompts,
 * and routes tool results — the LLM backend is irrelevant.
 */
export interface Capability {
  /** What tools does this capability expose for the current state? */
  getTools(): ToolDeclaration[];

  /** What does this capability contribute to the system prompt? */
  getPromptSections(): PromptSection[];

  /**
   * A tool was called and executed. Does this capability handle the result?
   *
   * @param toolName - The name of the tool that was called
   * @param args - The arguments passed to the tool
   * @param result - The result returned by the tool's execute()
   * @returns An action telling the host what to do, or null if this
   *          capability doesn't handle this tool.
   */
  processToolResult(toolName: string, args: unknown, result: unknown): CapabilityAction | null;
}

// ─── CapabilityHost ──────────────────────────────────────────────────────────

/**
 * Collects capabilities and exposes a unified interface for any LLM backend.
 *
 * Usage:
 * ```typescript
 * const host = new CapabilityHost()
 *   .use(new ExtractionCapability({ ... }))
 *   .use(new ExtractionCapability({ schema }))
 *   .use(new GuardrailCapability(policies));
 *
 * // For Gemini Live:
 * const tools = toGeminiDeclarations(host.getAllTools());
 * const prompt = host.getSystemPrompt(basePrompt);
 *
 * // For AI SDK:
 * const tools = toAISDKTools(host.getAllTools());
 * streamText({ system: prompt, tools });
 * ```
 */
export class CapabilityHost {
  private capabilities: Capability[] = [];
  private regularTools: ToolDeclaration[] = [];
  private _version = 0;
  private _lastCheckedVersion = 0;

  /** Add a capability (flow, triage, extraction, etc.). */
  use(capability: Capability): this {
    this.capabilities.push(capability);
    this._version++;
    return this;
  }

  /** Add regular tools not managed by any capability. */
  addTools(tools: ToolDeclaration[]): this {
    this.regularTools.push(...tools);
    this._version++;
    return this;
  }

  /**
   * Collect all tools from all capabilities + regular tools.
   *
   * Deduplicates by name — capability-provided tools take priority over
   * regular (agent-level) tools. This prevents duplicate function
   * declarations that providers like Gemini Live reject.
   */
  getAllTools(): ToolDeclaration[] {
    const capabilityTools = this.capabilities.flatMap(c => c.getTools());
    const seen = new Set(capabilityTools.map(t => t.name));
    const dedupedRegular = this.regularTools.filter(t => !seen.has(t.name));
    return [...capabilityTools, ...dedupedRegular];
  }

  /**
   * Build complete system prompt from base prompt + all capability sections.
   * Sections are ordered by role priority.
   */
  getSystemPrompt(basePrompt?: string): string {
    const sections = this.capabilities.flatMap(c => c.getPromptSections());
    return assemblePromptSections(basePrompt, sections);
  }

  /**
   * Route a tool result through capabilities. First capability to claim it wins.
   * If no capability claims it, returns `{ type: 'continue' }` (regular tool).
   */
  processToolResult(toolName: string, args: unknown, result: unknown): CapabilityAction {
    for (const cap of this.capabilities) {
      const action = cap.processToolResult(toolName, args, result);
      if (action) return action;
    }
    return { type: 'continue' };
  }

  /** Mark the current state as "seen" for reconfigure detection. */
  markConfigured(): void {
    this._lastCheckedVersion = this._version;
  }

  /** Bump version to signal that tools or prompt have changed. */
  notifyChanged(): void {
    this._version++;
  }

  /** True if tools or prompt changed since last `markConfigured()` call. */
  get needsReconfigure(): boolean {
    return this._version !== this._lastCheckedVersion;
  }

  /** Number of registered capabilities. */
  get capabilityCount(): number {
    return this.capabilities.length;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assemblePromptSections(basePrompt: string | undefined, sections: PromptSection[]): string {
  const parts: string[] = [];

  if (basePrompt) {
    parts.push(basePrompt);
  }

  // Sort sections by role priority
  const sorted = [...sections].sort((a, b) => {
    const orderA = SECTION_ORDER[a.role] ?? 100;
    const orderB = SECTION_ORDER[b.role] ?? 100;
    return orderA - orderB;
  });

  for (const section of sorted) {
    if (section.content.trim()) {
      parts.push(section.content);
    }
  }

  return parts.join('\n\n');
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export { ExtractionCapability } from './ExtractionCapability.js';
export type { ExtractionCapabilityConfig } from './ExtractionCapability.js';
export { GuardrailCapability } from './GuardrailCapability.js';
export { AutoRetrieveCapability } from './AutoRetrieveCapability.js';
export type { AutoRetrieveCapabilityConfig, RetrieveProvider } from './AutoRetrieveCapability.js';
export type {
  RefinementCapability,
  RefineInput,
  RefineDecision,
} from './RefinementCapability.js';
export type {
  ValidationCapability,
  ValidateInput,
  ValidateDecision,
} from './ValidationCapability.js';
export type { SourceRef } from '../types/index.js';
export { PassThroughRefinement } from './refinement/PassThrough.js';
export { PassThroughValidation } from './validation/PassThrough.js';
export { toGeminiDeclarations } from './adapters/gemini.js';
export type { GeminiFunctionDeclaration } from './adapters/gemini.js';
export { toAISDKTools } from './adapters/ai-sdk.js';
export { DefaultLivePromptAssembler, DEFAULT_VOICE_RULES, DEFAULT_GUARDRAILS } from './LivePromptAssembler.js';
export type {
  LivePromptAssembler,
  LivePromptContext,
  DefaultLivePromptAssemblerConfig,
} from './LivePromptAssembler.js';
