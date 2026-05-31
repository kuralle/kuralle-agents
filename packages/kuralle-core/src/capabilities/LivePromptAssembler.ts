/**
 * LivePromptAssembler — Port for building system prompts optimized for
 * realtime audio models (Gemini Live, OpenAI Realtime, etc.).
 *
 * This is the PORT (interface) in the Ports & Adapters pattern.
 * The default implementation (`DefaultLivePromptAssembler`) bridges
 * CapabilityHost with Runtime context (working memory, long-term memory,
 * policy injections) and structures the output per audio-model best practices.
 *
 * Adapters (Gemini, OpenAI Realtime, LiveKit) can extend or replace
 * the default with backend-specific voice rules and guardrails.
 *
 * Prompt structure follows Google's Live API best practices and
 * OpenAI's Realtime Prompting Guide:
 *
 *   1. Persona          — WHO you are
 *   2. Voice Rules      — Audio-specific constraints
 *   3. Conversation Flow — Current task + collected state
 *   4. Tool Directives  — WHEN to call each tool
 *   5. Context          — Working memory + long-term memory
 *   6. Guardrails       — Safety, escalation, unclear audio
 *
 * @see https://ai.google.dev/gemini-api/docs/live-api/best-practices
 * @see https://developers.openai.com/cookbook/examples/realtime_prompting_guide
 */

import type { Session } from '../types/index.js';
import type { CapabilityHost, ToolDeclaration } from './index.js';
import type { MemoryService } from '../memory/MemoryService.js';
import { preloadMemoryContext } from '../memory/preloadMemory.js';
import {
  formatMemoryWithBudget,
  type ContextBudgetConfig,
  DEFAULT_CONTEXT_BUDGET,
} from '../runtime/ContextBudget.js';

// ─── Port (Interface) ───────────────────────────────────────────────────────

/**
 * Input context for prompt assembly. Passed on every connect/reconfigure.
 */
export interface LivePromptContext {
  /** The CapabilityHost providing tools and prompt sections. */
  host: CapabilityHost;

  /** Base agent prompt (persona, role, core instructions). */
  basePrompt: string;

  /** Current session — used for working memory injection. */
  session?: Session;

  /** Cross-session memory service for long-term context. */
  memoryService?: MemoryService;

  /** Latest user input — used as search query for memory retrieval. */
  lastUserInput?: string;

  /** Policy injection strings (from InjectionQueue.getFor('system')). */
  policyInjections?: string;
}

/**
 * PORT: Assembles system prompts for realtime audio LLM sessions.
 *
 * Implementations control voice rules, guardrails, tool directive formatting,
 * and section ordering. The realtime orchestration authority calls this on
 * every connect and reconfigure, passing the current CapabilityHost state and
 * session context.
 */
export interface LivePromptAssembler {
  /**
   * Build a complete system prompt string from the given context.
   * May be async to support memory preloading.
   */
  assemble(ctx: LivePromptContext): Promise<string>;

  /**
   * Synchronous variant for initial connect (before any user input).
   * Skips async memory preloading.
   */
  assembleSync(ctx: Omit<LivePromptContext, 'memoryService' | 'lastUserInput'>): string;
}

// ─── Default Voice Rules & Guardrails ───────────────────────────────────────

export const DEFAULT_VOICE_RULES = `## Voice Rules
- Keep responses to 2-3 sentences per turn. Be concise.
- Do NOT output markdown, bullet points, numbered lists, or any formatting.
- Do NOT include sound effects, onomatopoeia, or non-speech sounds.
- Speak numbers digit-by-digit when reading codes or IDs: "4-1-5" not "four fifteen".
- If user audio is unclear, ask for clarification. Do not guess.
- Do NOT repeat back what the user just said. Move the conversation forward.
- Vary your responses. Do not use the same opening or confirmation phrase twice in a row.`;

export const DEFAULT_GUARDRAILS = `## Guardrails
- Only respond to clear audio or text input.
- If you cannot help with a request, say so briefly and offer to help with something else.
- All claims must be grounded in provided context or tool results. Do not fabricate information.
- If unsure about any action, ask for clarification rather than guessing.`;

// ─── Config ─────────────────────────────────────────────────────────────────

export interface DefaultLivePromptAssemblerConfig {
  /** Custom voice rules to override DEFAULT_VOICE_RULES. */
  voiceRules?: string;

  /** Custom guardrails to override DEFAULT_GUARDRAILS. */
  guardrails?: string;

  /** Working memory allowlist — only these keys are injected. */
  promptMemoryAllowlist?: string[];

  /** Token budget overrides. */
  budget?: Partial<ContextBudgetConfig>;
}

// ─── Default Adapter (Implementation) ───────────────────────────────────────

const INTERNAL_MEMORY_KEYS = [
  'runtimeEventLog',
  '__ariaSessionTurn',
  '__ariaRedactCarry',
  'flowStateByAgent',
  '__ariaAssistantText',
  '__ariaContextBudget',
];

/**
 * Default LivePromptAssembler implementation.
 *
 * Backend-agnostic — produces a plain string suitable for any realtime
 * audio model. Adapters can extend this class to add backend-specific
 * sections or override the voice rules.
 */
export class DefaultLivePromptAssembler implements LivePromptAssembler {
  private voiceRules: string;
  private guardrails: string;
  private allowlist?: string[];
  private budget: ContextBudgetConfig;

  constructor(config: DefaultLivePromptAssemblerConfig = {}) {
    this.voiceRules = config.voiceRules ?? DEFAULT_VOICE_RULES;
    this.guardrails = config.guardrails ?? DEFAULT_GUARDRAILS;
    this.allowlist = config.promptMemoryAllowlist;
    this.budget = { ...DEFAULT_CONTEXT_BUDGET, ...(config.budget ?? {}) };
  }

  async assemble(ctx: LivePromptContext): Promise<string> {
    const sections = this.buildCoreSections(ctx);

    // Async: long-term memory preload
    if (ctx.memoryService && ctx.session && ctx.lastUserInput) {
      const preloaded = await preloadMemoryContext(
        ctx.memoryService,
        ctx.session,
        ctx.lastUserInput,
        this.budget.maxLongTermMemoryTokens,
      );
      if (preloaded) {
        // Insert before guardrails (last section)
        sections.splice(sections.length - 1, 0, preloaded);
      }
    }

    return sections.join('\n\n');
  }

  assembleSync(ctx: Omit<LivePromptContext, 'memoryService' | 'lastUserInput'>): string {
    return this.buildCoreSections(ctx).join('\n\n');
  }

  /**
   * Build the core sections array. Shared by both sync and async paths.
   * Subclasses can override to add/reorder sections.
   */
  protected buildCoreSections(
    ctx: Omit<LivePromptContext, 'memoryService' | 'lastUserInput'>,
  ): string[] {
    const sections: string[] = [];

    // 1. Persona
    if (ctx.basePrompt.trim()) {
      sections.push(ctx.basePrompt.trim());
    }

    // 2. Voice Rules
    sections.push(this.voiceRules);

    // 3. Conversation Flow (capability prompt sections — task, state, extraction)
    const capSections = ctx.host.getSystemPrompt();
    if (capSections.trim()) {
      sections.push(capSections);
    }

    // 4. Tool Directives
    const tools = ctx.host.getAllTools();
    if (tools.length > 0) {
      sections.push(this.buildToolDirectives(tools));
    }

    // 5. Working Memory
    if (ctx.session) {
      const memBlock = this.buildWorkingMemorySection(ctx.session);
      if (memBlock) sections.push(memBlock);
    }

    // 6. Policy Injections
    if (ctx.policyInjections?.trim()) {
      sections.push(ctx.policyInjections.trim());
    }

    // 7. Guardrails (always last)
    sections.push(this.guardrails);

    return sections;
  }

  /**
   * Format tool declarations as in-prompt directives.
   * Subclasses can override for backend-specific formatting.
   */
  protected buildToolDirectives(tools: ToolDeclaration[]): string {
    const lines = ['## Available Tools'];
    for (const tool of tools) {
      let line = `- ${tool.name}: ${tool.description}`;
      const vd = tool.voiceDirective;
      if (vd?.preSpeech === 'force' && vd.preSpeechText?.trim()) {
        line += `\n  Before calling "${tool.name}", say exactly: "${vd.preSpeechText.trim()}"`;
      } else if (vd?.preSpeech === 'optional') {
        line += `\n  You may briefly acknowledge before calling "${tool.name}".`;
      } else if (vd?.preSpeech === 'force' && !vd.preSpeechText?.trim()) {
        line += `\n  You may briefly acknowledge before calling "${tool.name}".`;
      }
      lines.push(line);
    }

    lines.push('');
    lines.push('## Voice Tool Protocol');
    lines.push('- When the user\'s request matches an available tool\'s purpose, call the tool IMMEDIATELY in this turn. Do not only say you will check.');
    lines.push('- If required parameters are available from the conversation, call the tool now. Only ask a clarifying question when a required parameter is genuinely missing or ambiguous.');
    lines.push('- After receiving a tool result, summarize it in 1-2 spoken sentences. Do not read raw data or JSON to the user.');
    lines.push('- If a tool fails, say so once and offer an alternative. Do not retry.');
    lines.push('- Never reveal tool names, function signatures, or internal routing to the user.');

    return lines.join('\n');
  }

  /**
   * Extract and format working memory from the session.
   */
  private buildWorkingMemorySection(session: Session): string | null {
    const memory = session.workingMemory ?? {};
    const filtered: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(memory)) {
      if (INTERNAL_MEMORY_KEYS.includes(key)) continue;
      if (this.allowlist && !this.allowlist.includes(key)) continue;
      filtered[key] = value;
    }

    if (Object.keys(filtered).length === 0) return null;

    const block = formatMemoryWithBudget(filtered, this.budget.maxWorkingMemoryTokens);
    return block.trim() || null;
  }
}
