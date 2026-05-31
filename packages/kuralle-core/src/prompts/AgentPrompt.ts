/**
 * AgentPrompt — Developer-facing class for structured prompt assembly.
 *
 * Provides a chainable API for composing agent prompts with automatic
 * security sandwiching, priority-based ordering, and XML-tagged rendering.
 *
 * @example
 * ```ts
 * const prompt = new AgentPrompt()
 *   .role('You are a helpful customer support agent.')
 *   .instructions('Help customers with billing and account issues.')
 *   .guardrails('Never share internal pricing or discount formulas.')
 *   .knowledge(async () => fetchKnowledgeBase())
 *   .tools(myToolSet);
 *
 * const systemPrompt = await prompt.render();
 * ```
 *
 * @module
 */

import type { ToolSet } from '../tools/Tool.js';
import type { GlossaryTerm, VoiceRulesConfig, PolicyProfile } from './types.js';
import { getSecurityCore, SECURITY_REMINDER } from './security.js';
import { PromptAssembly } from './PromptAssembly.js';
import type { AssemblyDebugInfo } from './PromptAssembly.js';
import { renderSections } from './PromptRenderer.js';
import type { RenderOptions } from './PromptRenderer.js';
import { composePersonaPrompt, type PersonaConfig } from '../persona/index.js';

// ============================================
// Types
// ============================================

/**
 * Configuration for the AgentPrompt constructor.
 */
export interface AgentPromptConfig {
  /** Security policy profile. Defaults to 'minimal'. */
  policy?: PolicyProfile;
  /** Whether to wrap sections in XML tags. Defaults to true. */
  xmlTags?: boolean;
  /** Maximum token budget for the rendered prompt. */
  maxTokens?: number;
  /** Disable automatic security core and reminder sections. Defaults to false. */
  disableSecurity?: boolean;
}

// ============================================
// AgentPrompt
// ============================================

/**
 * Developer-facing prompt builder with a chainable API.
 *
 * Internally creates a {@link PromptAssembly}, injects security core (priority 0)
 * and security reminder (priority 1000), then freezes security bands.
 *
 * All chainable methods accept either a static string or an async function
 * that resolves to a string.
 */
export class AgentPrompt {
  private readonly _assembly: PromptAssembly;
  private readonly renderOptions: RenderOptions;

  constructor(config: AgentPromptConfig = {}) {
    const {
      policy = 'minimal',
      xmlTags = true,
      maxTokens,
      disableSecurity = false,
    } = config;

    this._assembly = new PromptAssembly();
    this.renderOptions = {
      useXmlTags: xmlTags,
      maxTokens,
      validateSecurity: !disableSecurity,
    };

    if (!disableSecurity) {
      this._assembly.addSection({
        type: 'security_core',
        content: getSecurityCore(policy),
        priority: 0,
        shrinkable: false,
        tag: 'security_core',
        source: 'security',
      });

      this._assembly.addSection({
        type: 'security_reminder',
        content: SECURITY_REMINDER,
        priority: 1000,
        shrinkable: false,
        tag: 'security_reminder',
        source: 'security',
      });

      this._assembly.freeze();
    }
  }

  // ============================================
  // Chainable section methods
  // ============================================

  /**
   * Sets the agent's role description. Priority 10, non-shrinkable.
   */
  role(content: string | (() => Promise<string>)): this {
    this._assembly.addSection({
      type: 'role',
      content,
      priority: 10,
      shrinkable: false,
      tag: 'role',
      source: 'developer',
    });
    return this;
  }

  /**
   * Sets the agent's instructions. Priority 15, non-shrinkable.
   */
  instructions(content: string | (() => Promise<string>)): this {
    this._assembly.addSection({
      type: 'instructions',
      content,
      priority: 15,
      shrinkable: false,
      tag: 'instructions',
      source: 'developer',
    });
    return this;
  }

  /**
   * Sets the agent's first-class persona. Priority 17, non-shrinkable.
   */
  persona(persona: PersonaConfig): this {
    this._assembly.addSection({
      type: 'persona',
      content: composePersonaPrompt(persona),
      priority: 17,
      shrinkable: false,
      tag: 'persona',
      source: 'developer',
    });
    return this;
  }

  /**
   * Sets guardrail rules. Priority 20, non-shrinkable.
   */
  guardrails(content: string | (() => Promise<string>)): this {
    this._assembly.addSection({
      type: 'guardrails',
      content,
      priority: 20,
      shrinkable: false,
      tag: 'guardrails',
      source: 'developer',
    });
    return this;
  }

  /**
   * Sets voice/personality description. Priority 25, shrinkable.
   */
  voice(content: string | (() => Promise<string>)): this {
    this._assembly.addSection({
      type: 'voice',
      content,
      priority: 25,
      shrinkable: true,
      tag: 'voice',
      source: 'developer',
    });
    return this;
  }

  /**
   * Injects knowledge context. Priority 30, shrinkable.
   */
  knowledge(content: string | (() => Promise<string>)): this {
    this._assembly.addSection({
      type: 'knowledge',
      content,
      priority: 30,
      shrinkable: true,
      tag: 'knowledge',
      source: 'developer',
    });
    return this;
  }

  /**
   * Sets business/domain rules. Priority 35, shrinkable.
   */
  rules(content: string | (() => Promise<string>)): this {
    this._assembly.addSection({
      type: 'rules',
      content,
      priority: 35,
      shrinkable: true,
      tag: 'rules',
      source: 'developer',
    });
    return this;
  }

  /**
   * Adds a glossary of domain terms. Priority 38, shrinkable.
   * Terms are auto-formatted into a structured list.
   */
  glossary(terms: GlossaryTerm[]): this {
    const content = formatGlossary(terms);
    this._assembly.addSection({
      type: 'glossary',
      content,
      priority: 38,
      shrinkable: true,
      tag: 'glossary',
      source: 'developer',
    });
    return this;
  }

  /**
   * Generates tool descriptions from a ToolSet. Priority 40, shrinkable.
   */
  tools(toolSet: ToolSet): this {
    const content = formatToolDescriptions(toolSet);
    this._assembly.addSection({
      type: 'tools',
      content,
      priority: 40,
      shrinkable: true,
      tag: 'tools',
      source: 'developer',
    });
    return this;
  }

  /**
   * Sets voice/TTS output rules. Priority 45, shrinkable.
   * Uses the same formatting logic as PromptTemplateBuilder.formatVoiceRules.
   */
  voiceRules(config: VoiceRulesConfig): this {
    const content = formatVoiceRules(config);
    this._assembly.addSection({
      type: 'voice_rules',
      content,
      priority: 45,
      shrinkable: true,
      tag: 'voice_rules',
      source: 'developer',
    });
    return this;
  }

  /**
   * Adds example interactions or few-shot prompts. Priority 50, shrinkable.
   */
  examples(content: string | (() => Promise<string>)): this {
    this._assembly.addSection({
      type: 'examples',
      content,
      priority: 50,
      shrinkable: true,
      tag: 'examples',
      source: 'developer',
    });
    return this;
  }

  /**
   * Adds an arbitrary named section. Defaults to priority 60, shrinkable.
   */
  section(
    type: string,
    content: string | (() => Promise<string>),
    priority = 60,
  ): this {
    this._assembly.addSection({
      type,
      content,
      priority,
      shrinkable: true,
      tag: type,
      source: 'developer',
    });
    return this;
  }

  // ============================================
  // Render & Debug
  // ============================================

  /**
   * Resolves all sections and renders the prompt to a string.
   */
  async render(): Promise<string> {
    const resolved = await this._assembly.resolve();
    return renderSections(resolved, this.renderOptions);
  }

  /**
   * Returns debug information about the assembly's current state.
   */
  async debug(): Promise<AssemblyDebugInfo> {
    return this._assembly.debug();
  }

  /**
   * Exposes the underlying PromptAssembly for runtime injection.
   */
  get assembly(): PromptAssembly {
    return this._assembly;
  }
}

// ============================================
// Formatters (internal)
// ============================================

/** Formats glossary terms into a readable list. */
function formatGlossary(terms: GlossaryTerm[]): string {
  if (terms.length === 0) return '';

  const lines: string[] = ['## Domain Glossary', ''];
  lines.push('The following terms have specific meanings in this context:');
  lines.push('');

  for (const term of terms) {
    lines.push(`### ${term.name}`);
    lines.push(`**Description:** ${term.description}`);
    if (term.synonyms && term.synonyms.length > 0) {
      lines.push(`**Synonyms:** ${term.synonyms.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Formats a ToolSet into readable tool descriptions. */
function formatToolDescriptions(toolSet: ToolSet): string {
  const entries = Object.entries(toolSet);
  if (entries.length === 0) return '';

  const descriptions = entries.map(([name, tool]) => {
    const desc = 'description' in tool ? String(tool.description) : '';
    return `### ${name}\n${desc}`;
  });

  return `## Available Tools\n\n${descriptions.join('\n\n')}`;
}

/**
 * Formats voice rules configuration into a structured text block.
 * Logic ported from PromptTemplateBuilder.formatVoiceRules.
 */
function formatVoiceRules(cfg: VoiceRulesConfig): string {
  const rules: string[] = [];

  rules.push('Your responses will be converted to speech. Follow these rules for natural TTS output:');

  rules.push('## Formatting');
  rules.push('1. **Punctuation**: Use proper punctuation at the end of every sentence.');
  rules.push('2. **No special characters**: Avoid emojis, markdown formatting, or special unicode characters.');
  rules.push('3. **No quotation marks**: Avoid unless explicitly quoting someone.\n');

  rules.push('## Numbers & Dates');
  if (cfg.formatDates === 'MM/DD/YYYY') {
    rules.push('- **Dates**: Write as MM/DD/YYYY (e.g., "04/20/2023" not "April 20th").');
  } else if (cfg.formatDates === 'speakable') {
    rules.push('- **Dates**: Speak in natural form (e.g., "April twentieth, twenty twenty-three").');
  }
  if (cfg.formatTimes === '12h') {
    rules.push('- **Times**: Use 12-hour format with space before AM/PM (e.g., "7:00 PM" not "7:00PM").');
  }

  if (cfg.useSpellTags) {
    rules.push('\n## Identifiers (Spelling)');
    rules.push('- Wrap identifiers in <spell> tags:');
    rules.push('  - Order numbers: "<spell>A1B2C3</spell>"');
    rules.push('  - Phone numbers: "<spell>555-123-4567</spell>"');
    rules.push('  - Confirmation codes: "<spell>XYZ789</spell>"');
    rules.push('  - Email addresses: "<spell>user@example.com</spell>"');
  } else {
    rules.push('\n## Identifiers');
    rules.push('- Spell out identifiers digit by digit: "A one B two C three"');
    rules.push('- Phone numbers: "five five five, one two three, four five six seven"');
    rules.push('- Email addresses: "user at example dot com"');
  }

  if (cfg.urlFormat === 'dot') {
    rules.push('\n## URLs & Emails');
    rules.push('- Say "dot" instead of ".": "example dot com"');
    rules.push('- Say "at" instead of "@": "user at example dot com"');
  }

  rules.push('\n## Pauses & Breaks');
  if (cfg.useBreakTags) {
    rules.push('- Use <break time="Xs"/> for pauses: "Let me check.<break time="1s"/>Okay..."');
    rules.push('- Shorter breaks (200-500ms) between list items.');
  } else {
    rules.push('- Use natural pauses with punctuation and dashes.');
    rules.push('- Use "\u2014" (em dash) for longer pauses in speech.');
  }

  if (cfg.useSpeedTags) {
    rules.push('\n## Speaking Pace');
    rules.push('- Use <speed ratio="0.8"/> for slow, clear explanations.');
    rules.push('- Use <speed ratio="1.2"/> for quick summaries.');
    rules.push('- Normal speed is ratio 1.0.');
  }

  if (cfg.useEmotionTags) {
    rules.push('\n## Emotional Expression');
    rules.push('- Use <emotion value="..."/> for tone: neutral, excited, sympathetic, curious, etc.');
    rules.push('- Emotions: happy, excited, content, sad, scared, curious, sympathetic, calm.');
    rules.push('- Match emotion to content - do not use conflicting tones.');
  }

  if (cfg.useLaughterTags) {
    rules.push('\n## Nonverbal Sounds');
    rules.push('- Use [laughter] to indicate laughing: "That is funny! [laughter]"');
    rules.push('- Use sparingly for natural effect.');
  }

  if (cfg.verbalizeCurrency) {
    rules.push('\n## Currency');
    rules.push('- Say "five dollars" not "$5"');
    rules.push('- Say "five ninety-nine" not "$5.99"');
  }

  if (cfg.verbalizeSymbols) {
    rules.push('\n## Symbols');
    rules.push('- Say "percent" not "%"');
    rules.push('- Say "dollar" not "$"');
    rules.push('- Say "equals" not "="');
  }

  if (cfg.customPronunciations) {
    rules.push('\n## Custom Pronunciations');
    for (const [word, pronunciation] of Object.entries(cfg.customPronunciations)) {
      rules.push(`- "${word}" should be pronounced: "${pronunciation}"`);
    }
  }

  rules.push('\n## Speaking Style');
  rules.push('- Be concise and conversational.');
  rules.push("- Use contractions (I'm, you're, we'll).");
  rules.push('- Avoid abbreviations: say "versus" not "vs.", "for example" not "e.g."');
  rules.push('- For lists, use natural connectors: "first, second, third" not bullet points.');

  return rules.filter((r) => r.trim()).join('\n');
}
