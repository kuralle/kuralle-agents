import type { ToolSet } from '../tools/Tool.js';
import type { PersonaConfig } from '../persona/types.js';

export type PromptSectionType =
  // Layer 0: Security Core (immutable)
  | 'security_core'
  // Layer 1: Agent Definition
  | 'identity'
  | 'role'
  | 'persona'
  | 'capabilities'
  // Layer 2: Brand Voice
  | 'brand_voice'
  | 'tone'
  | 'personality'
  // Layer 3: Knowledge & Grounding
  | 'knowledge'
  | 'grounding_rules'
  | 'glossary'
  | 'business_rules'
  // Layer 4: Tools & Actions
  | 'tools'
  | 'tool_contract'
  // Layer 5: Session Memory
  | 'session_state'
  | 'flow_context'
  | 'conversation_summary'
  // Layer 6: Security Reminder
  | 'security_reminder'
  // Legacy/Other
  | 'personality'
  | 'goal'
  | 'guardrails'
  | 'character_normalization'
  | 'voice_rules'
  | 'system_reminder'
  | 'error_handling'
  | 'handoff'
  | 'brief_speech'
  | 'custom';

// Layer priorities for 6+2 architecture
// Priority 0-9: Security Core (immutable)
// Priority 10-19: Agent Definition (user)
// Priority 20-29: Brand Voice (user)
// Priority 30-39: Knowledge & Grounding (mixed)
// Priority 40-49: Tools & Actions (auto)
// Priority 50-59: Session Memory (auto)
// Priority 1000+: Security Reminder (immutable)
export const LAYER_PRIORITIES = {
  SECURITY_CORE: { min: 0, max: 9 },
  IDENTITY: 10,
  ROLE: 15,
  PERSONA: 17,
  BRAND_VOICE: 20,
  TONE: 25,
  PERSONALITY: 28,
  KNOWLEDGE: 30,
  BUSINESS_RULES: 35,
  GROUNDING_RULES: 38,
  GLOSSARY: 39,
  TOOLS: 40,
  TOOL_CONTRACT: 45,
  SESSION_STATE: 50,
  FLOW_CONTEXT: 55,
  CONVERSATION_SUMMARY: 58,
  SECURITY_REMINDER: 1000,
} as const;

export type PolicyProfile = 'minimal' | 'safe' | 'regulated';

export interface BrandVoiceConfig {
  personality?: string;
  tone?: 'formal' | 'casual' | 'friendly' | 'professional' | 'custom';
  toneCustom?: string;
  styleRules?: string[];
  avoidPhrases?: string[];
  preferredPhrases?: string[];
  emojiPolicy?: 'never' | 'minimal' | 'moderate' | 'encouraged';
  responseLength?: 'brief' | 'moderate' | 'detailed';
}

export interface KnowledgeContext {
  retrieved?: string;
  glossary?: GlossaryTerm[];
  businessRules?: string[];
}

export interface SessionMemory {
  conversationState?: Record<string, unknown>;
  flowProgress?: { currentNode: string; collectedData: Record<string, unknown> };
  workingMemory?: Array<{ label: string; content: string }>;
}

export interface AgentDefinition {
  identity: string;
  role: string;
  capabilities?: string[];
}

export interface PromptBuilderConfig {
  template?: PromptTemplate;
  agentDefinition?: AgentDefinition;
  persona?: PersonaConfig;
  brandVoice?: BrandVoiceConfig;
  knowledgeContext?: KnowledgeContext;
  tools?: ToolSet;
  sessionMemory?: SessionMemory;
  policyProfile?: PolicyProfile;
}

export interface PromptSection {
  type: PromptSectionType;
  content: string;
  priority?: number;
  /** If true, this section cannot be overridden (security layers) */
  immutable?: boolean;
}

export interface ToolGuideline {
  name: string;
  whenToUse: string;
  howToUse: string;
  errorHandling: string;
}

export interface VoiceRulesConfig {
  /** Cartesia-specific <spell> tags. Defaults to false for cross-TTS compatibility. */
  useSpellTags?: boolean;
  /** Cartesia-specific <break> tags. Defaults to false. */
  useBreakTags?: boolean;
  /** Cartesia-specific <speed> tags. Defaults to false. */
  useSpeedTags?: boolean;
  /** Cartesia-specific <emotion> tags. Defaults to false. */
  useEmotionTags?: boolean;
  /** Cartesia-specific [laughter] tags. Defaults to false. */
  useLaughterTags?: boolean;
  customPronunciations?: Record<string, string>;
  formatDates?: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'speakable';
  formatTimes?: '12h' | '24h';
  urlFormat?: 'dot' | 'spell';
  numberFormat?: 'words' | 'digits' | 'mixed';
  verbalizeCurrency?: boolean;
  verbalizeSymbols?: boolean;
}

export interface VoiceRules {
  config: VoiceRulesConfig;
  rules: string[];
}

export interface GlossaryTerm {
  name: string;
  description: string;
  synonyms?: string[];
  category?: string; // Extensible for future categorization
}

export interface GlossaryConfig {
  terms: GlossaryTerm[];
  format?: 'list' | 'table' | 'detailed'; // Extensible for future formats
}

export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  sections: PromptSection[];
  requiredSections: PromptSectionType[];
}

export interface PromptTemplateBuilderOptions {
  id: string;
  name: string;
  description?: string;
}

export class PromptTemplateBuilder {
  private readonly id: string;
  private readonly name: string;
  private readonly description?: string;
  private sections: PromptSection[] = [];
  private toolGuidelines: ToolGuideline[] = [];
  private toolsProvided: boolean = false;
  private voiceRulesConfig: VoiceRulesConfig = {};
  private glossaryTerms: GlossaryTerm[] = [];
  private injectTodayDateFlag: boolean = true; // Default to true for .default() to include date

  constructor(options: PromptTemplateBuilderOptions) {
    this.id = options.id;
    this.name = options.name;
    this.description = options.description;
  }

  personality(content: string): this {
    this.addSection('personality', content, 10);
    return this;
  }

  goal(content: string): this {
    this.addSection('goal', content, 20);
    return this;
  }

  guardrails(content: string): this {
    this.addSection('guardrails', content, 30);
    return this;
  }

  tools(content: string): this {
    this.addSection('tools', content, 70);
    return this;
  }

  tone(content: string): this {
    this.addSection('tone', content, 40);
    return this;
  }

  characterNormalization(content: string): this {
    this.addSection('character_normalization', content, 60);
    return this;
  }

  voiceRules(config?: VoiceRulesConfig): this {
    this.voiceRulesConfig = { ...this.voiceRulesConfig, ...config };
    return this;
  }

  enableVoiceRules(config?: VoiceRulesConfig): this {
    return this.voiceRules(config);
  }

  glossary(terms: GlossaryTerm[]): this {
    this.glossaryTerms = [...this.glossaryTerms, ...terms];
    return this;
  }

  addTerm(name: string, description: string, synonyms?: string[]): this {
    this.glossaryTerms.push({ name, description, synonyms });
    return this;
  }

  handoff(instruction: string = `
## HANDOFF CONTEXT (CRITICAL)
You are receiving a handoff. Check the conversation history for the 'handoff' tool result.
The user's original intent is in the 'reason' or 'summary' field.
DO NOT re-greet or ask "How can I help?".
ACT on their specific need immediately.
- If they wanted to perform an action, start IMMEDIATELY.
- If they asked a question, answer it IMMEDIATELY.
`): this {
    // Audit Note: Priority boosted to 20 (just after goal) so it overrides standard greetings
    this.addSection('handoff', instruction, 20);
    return this;
  }

  injectTodayDate(enabled: boolean = true): this {
    this.injectTodayDateFlag = enabled;
    return this;
  }

  errorHandling(content: string): this {
    this.addSection('error_handling', content, 50);
    return this;
  }

  briefSpeech(content: string = `Keep responses brief—you're collecting information, not lecturing. Use natural, conversational language. Avoid repeating "Great!" or "Excellent!" after every answer. Vary your acknowledgments and transition smoothly to the next question.`): this {
    this.addSection('brief_speech', content, 45); // Priority 45, between tone (40) and error_handling (50)
    return this;
  }

  custom(name: string, content: string, priority?: number): this {
    // Special case: if creating a "System Reminder" section, use system_reminder type
    const sectionType = name.toLowerCase() === 'system reminder' ? 'system_reminder' : 'custom';
    this.addSection(sectionType, sectionType === 'custom' ? `# ${name}\n\n${content}` : content, priority);
    return this;
  }

  toolGuideline(guideline: ToolGuideline): this {
    this.toolGuidelines.push(guideline);
    return this;
  }

  toolsSet(tools: ToolSet): this {
    const toolDescriptions = Object.entries(tools).map(([name, tool]) => {
      const desc = 'description' in tool ? String(tool.description) : '';
      return `### ${name}\n${desc}`;
    }).join('\n\n');
    this.addSection('tools', toolDescriptions);
    this.toolsProvided = true;
    return this;
  }

  default(tools?: ToolSet): this {
    const hasCustomPersonality = this.sections.some(s => s.type === 'personality');
    const hasCustomGoal = this.sections.some(s => s.type === 'goal');
    const hasCustomGuardrails = this.sections.some(s => s.type === 'guardrails');
    const hasCustomTone = this.sections.some(s => s.type === 'tone');
    const hasCustomErrorHandling = this.sections.some(s => s.type === 'error_handling');
    const hasCustomCharNorm = this.sections.some(s => s.type === 'character_normalization');
    const hasCustomVoiceRules = this.sections.some(s => s.type === 'voice_rules');
    const hasCustomTools = this.sections.some(s => s.type === 'tools');

    if (!hasCustomPersonality) {
      this.addSection('personality', `You are a ${this.name}. You are professional, helpful, and adapt your communication style to match the user's needs.`, 10);
    }

    if (!hasCustomGoal) {
      this.addSection('goal', `Your goal is to understand the user's request, provide accurate and helpful information, and complete tasks efficiently while maintaining a high quality of service.`, 20);
    }

    if (!hasCustomGuardrails) {
      this.addSection('guardrails', `Never make up information. If you don't know something, admit it clearly and offer to find out. Never share sensitive information unless properly verified. Escalate to a human when appropriate.`, 30);
    }

    if (!hasCustomTone) {
      this.addSection('tone', `Use clear, concise language. Be friendly but professional. Avoid jargon unless the user demonstrates familiarity with it.`, 40);
    }

    if (!hasCustomErrorHandling) {
      this.addSection('error_handling', `When you encounter an error or cannot complete a request: 1) Acknowledge the issue clearly, 2) Don't guess or make up solutions, 3) Offer alternatives or suggest next steps.`, 50);
    }

    if (!hasCustomCharNorm) {
      this.addSection('character_normalization', `Normalize user input for speech recognition systems: 1) Convert email addresses to speakable format (at-sign as "at", dot as "dot"), 2) Spell out phone numbers digit by digit, 3) Format codes and IDs with spaces or pauses.`);
    }

    if (tools && !hasCustomTools) {
      this.toolsSet(tools);
    }

    // Set injectTodayDateFlag to true by default in .default()
    if (this.injectTodayDateFlag === true) {
      // Flag is already true, do nothing
    } else if (this.injectTodayDateFlag === undefined) {
      this.injectTodayDateFlag = true; // Enable by default in .default()
    }

    return this;
  }

  build(): PromptTemplate {
    // Clone sections to avoid side effects
    const sections = [...this.sections];

    const guidelineSection = this.toolGuidelines.length > 0
      ? {
        type: 'custom' as const,
        content: this.formatToolGuidelines(),
        priority: 80,
      }
      : null;

    if (guidelineSection) {
      sections.push(guidelineSection);
    }

    if (Object.keys(this.voiceRulesConfig).length > 0) {
      const voiceRulesContent = this.formatVoiceRules();
      // Use helper logic locally or just push constructed object
      // Re-implementing ensure-unique logic locally for the build scope
      const type = 'voice_rules';
      const existingIndex = sections.findIndex(s => s.type === type);
      if (existingIndex !== -1) {
        sections[existingIndex] = { type, content: voiceRulesContent, priority: 65 };
      } else {
        sections.push({ type, content: voiceRulesContent, priority: 65 });
      }
    }

    if (this.glossaryTerms.length > 0) {
      const glossaryContent = this.formatGlossary();
      const type = 'glossary';
      const existingIndex = sections.findIndex(s => s.type === type);
      if (existingIndex !== -1) {
        sections[existingIndex] = { type, content: glossaryContent, priority: 55 };
      } else {
        sections.push({ type, content: glossaryContent, priority: 55 });
      }
    }

    if (this.injectTodayDateFlag) {
      const hasCustomSystemReminder = sections.some(s => s.type === 'system_reminder');
      if (!hasCustomSystemReminder) {
        const today = new Date().toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
        sections.push({ type: 'system_reminder', content: `Today is ${today}.`, priority: 25 });
      }
    }

    const requiredSections: PromptSectionType[] = ['personality', 'goal', 'guardrails'];

    sections.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    return {
      id: this.id,
      name: this.name,
      description: this.description,
      sections: sections,
      requiredSections,
    };
  }

  private addSection(type: PromptSectionType, content: string, priority?: number): void {
    if (type === 'custom') {
      this.sections.push({ type, content, priority });
      return;
    }
    const existingIndex = this.sections.findIndex(s => s.type === type);
    if (existingIndex !== -1) {
      this.sections[existingIndex] = { type, content, priority };
    } else {
      this.sections.push({ type, content, priority });
    }
  }

  private formatToolGuidelines(): string {
    return `## Tool Usage Guidelines\n\n${this.toolGuidelines.map(g => `### ${g.name}\n**When to use:** ${g.whenToUse}\n\n**How to use:** ${g.howToUse}\n\n**Error handling:** ${g.errorHandling}`).join('\n\n---\n\n')}`;
  }

  private formatVoiceRules(): string {
    const rules: string[] = [];
    const cfg = this.voiceRulesConfig;

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

    // useSpellTags defaults to false for cross-TTS compatibility (Cartesia-specific feature)
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
      rules.push('- Use "—" (em dash) for longer pauses in speech.');
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
    rules.push('- Use contractions (I\'m, you\'re, we\'ll).');
    rules.push('- Avoid abbreviations: say "versus" not "vs.", "for example" not "e.g."');
    rules.push('- For lists, use natural connectors: "first, second, third" not bullet points.');

    return rules.filter(r => r.trim()).join('\n');
  }

  private formatGlossary(): string {
    if (this.glossaryTerms.length === 0) {
      return '';
    }

    const lines: string[] = ['## Domain Glossary'];
    lines.push('');
    lines.push('The following terms have specific meanings in this context:');
    lines.push('');

    for (const term of this.glossaryTerms) {
      lines.push(`### ${term.name}`);
      lines.push(`**Description:** ${term.description}`);

      if (term.synonyms && term.synonyms.length > 0) {
        lines.push(`**Synonyms:** ${term.synonyms.join(', ')}`);
      }

      lines.push(''); // Blank line between terms
    }

    return lines.join('\n');
  }
}

export function createPromptTemplate(
  id: string,
  name: string,
  configure: (builder: PromptTemplateBuilder) => void
): PromptTemplate {
  const builder = new PromptTemplateBuilder({ id, name });
  configure(builder);
  return builder.build();
}
